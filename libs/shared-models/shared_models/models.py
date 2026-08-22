"""SQLAlchemy ORM models for the CT annotation platform.

This module is the single source of truth for the database schema. It is
shared (as an installable local package) across all services -- ingestion,
data, annotation, admin -- and by the Alembic migrations in
infra/migrations. Do not duplicate table definitions in a service; import
them from here instead.
"""
import enum
import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.sql import func


class Base(DeclarativeBase):
    """Base class for all ORM models."""


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class StudyRole(str, enum.Enum):
    """Roles a user can hold on a given study, via StudyMembership."""

    ADMIN = "admin"
    DATA_MANAGER = "data_manager"
    ANNOTATOR = "annotator"
    REVIEWER = "reviewer"
    VIEWER = "viewer"


class AnnotationStatus(str, enum.Enum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    APPROVED = "approved"
    REJECTED = "rejected"


class DeidentificationAction(str, enum.Enum):
    """What to do with a DICOM tag during ingestion de-identification."""

    KEEP = "keep"
    REMOVE = "remove"
    REPLACE_FIXED = "replace_fixed"
    HASH = "hash"


class ConsentStatus(str, enum.Enum):
    GRANTED = "granted"
    REVOKED = "revoked"


class WorkflowCardType(str, enum.Enum):
    """The fixed set of card types a Study's workflow board can contain.
    See WorkflowCard."""

    DATASET = "dataset"
    SPLIT = "split"
    FILTER = "filter"
    ANNOTATION = "annotation"
    REVIEW = "review"
    UNION = "union"
    NOTE = "note"
    MILESTONE = "milestone"


class Study(Base):
    """A study scopes data access: every case belongs to exactly one
    study, and per-study roles are granted via StudyMembership. This is
    the platform's top-level, admin-created organizational/RBAC container
    (e.g. a research study or clinical protocol) -- not to be confused
    with `ImagingStudy`, the DICOM per-session imaging entity that hangs
    off a Case."""

    __tablename__ = "studies"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    deidentification_profile_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("deidentification_profiles.id")
    )
    # Optional cover image for the study card grid in admin-ui. Same
    # pointer-to-object-storage pattern as Instance.object_storage_key.
    cover_image_key: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    memberships: Mapped[list["StudyMembership"]] = relationship(back_populates="study")
    cases: Mapped[list["Case"]] = relationship(back_populates="study")


class StudyMembership(Base):
    """Grants a Keycloak user a role scoped to one study.

    A global Keycloak realm role of "admin" bypasses this table entirely
    (see shared_auth.require_study_role) -- this table is only consulted
    for non-global-admin, study-scoped access decisions.
    """

    __tablename__ = "study_memberships"

    study_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("studies.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(255), primary_key=True)  # Keycloak "sub" claim
    role: Mapped[StudyRole] = mapped_column(nullable=False)

    study: Mapped["Study"] = relationship(back_populates="memberships")


class DeidentificationProfile(Base):
    """An admin-editable, named set of de-identification rules.

    Assigned to a Study via Study.deidentification_profile_id. The rules
    are data, not code, so compliance decisions can change without a
    deployment -- see DeidentificationRule.
    """

    __tablename__ = "deidentification_profiles"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    rules: Mapped[list["DeidentificationRule"]] = relationship(back_populates="profile")


class DeidentificationRule(Base):
    """One per-DICOM-tag rule within a DeidentificationProfile."""

    __tablename__ = "deidentification_rules"

    id: Mapped[uuid.UUID] = _uuid_pk()
    profile_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("deidentification_profiles.id"))
    dicom_tag: Mapped[str] = mapped_column(String(32), nullable=False)  # e.g. "(0010,0010)"
    action: Mapped[DeidentificationAction] = mapped_column(nullable=False)
    replacement_value: Mapped[str | None] = mapped_column(String(255))  # only used by REPLACE_FIXED

    profile: Mapped["DeidentificationProfile"] = relationship(back_populates="rules")


class Patient(Base):
    """A pseudonymized patient. Holds no directly identifying data -- the
    real identifier only exists (hashed) in PatientIdentityMap."""

    __tablename__ = "patients"

    id: Mapped[uuid.UUID] = _uuid_pk()
    pseudonym_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    cases: Mapped[list["Case"]] = relationship(back_populates="patient")


class PatientIdentityMap(Base):
    """Restricted-access table mapping a hashed external patient id back to
    a pseudonym. This is the only table where re-identification is
    possible; access to it must be locked down separately (e.g. a dedicated
    DB role not granted to the data/annotation services).
    """

    __tablename__ = "patient_identity_map"

    patient_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("patients.id"), primary_key=True)
    external_id_hash: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    access_restricted: Mapped[bool] = mapped_column(Boolean, default=True)


class Case(Base):
    """The central clinical entity. A Case identifies which patient and
    study a body of data belongs to; both imaging (ImagingStudy -> Series
    -> Instance) and non-imaging (ClinicalDataItem) data hang off a Case
    rather than referencing Study/Patient directly, so "everything
    belonging to this patient's episode" has one place to attach to,
    regardless of kind. See ARCHITECTURE.md, "Case-centric data model".
    """

    __tablename__ = "cases"

    id: Mapped[uuid.UUID] = _uuid_pk()
    study_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("studies.id"), nullable=False)
    patient_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("patients.id"), nullable=False)
    accession_number: Mapped[str | None] = mapped_column(String(64))
    # Case-level summary fields, independent of any individual
    # ClinicalDataItem (which has its own date/type/title) -- a
    # quick-glance identity for the case as a whole.
    date: Mapped[Date | None] = mapped_column(Date)
    type: Mapped[str | None] = mapped_column(String(64))
    title: Mapped[str | None] = mapped_column(String(255))
    comment: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    study: Mapped["Study"] = relationship(back_populates="cases")
    patient: Mapped["Patient"] = relationship(back_populates="cases")
    imaging_studies: Mapped[list["ImagingStudy"]] = relationship(back_populates="case")
    clinical_data_items: Mapped[list["ClinicalDataItem"]] = relationship(back_populates="case")


class WorkflowCard(Base):
    """One node on a Study's workflow board -- a freeform, drag/connect
    canvas for organizing project work (dataset prep -> annotation ->
    review -> merge) that a user builds manually, card by card. There is
    exactly one board per Study, so the Study itself is the board's scope
    -- no separate "board" entity to join through.

    `config` holds only user-editable settings (shape depends on `type`);
    `output_case_ids` holds the result of the last Run and is never
    hand-edited -- see app/api/workflow.py in admin-service for the exact
    per-type shapes and the Run algorithms. Dataset/Note/Milestone cards
    are never Run: a Dataset's case set is computed live (or is a static
    manually-picked list) and Note/Milestone are pure annotations on the
    board with no data behind them.

    `materialized_source_card_id`/`materialized_source_handle` are set only
    on a Dataset card that was auto-created by another card's Run (a Split
    part, or an Annotation/Review's opt-in "also create a dataset" toggle)
    -- they let a re-Run find and update that same Dataset card in place
    instead of spawning a duplicate each time. `ondelete=SET NULL` because
    a materialized Dataset is a real, independently useful snapshot: if its
    source card is later deleted, the Dataset should survive as a plain
    manual-mode Dataset, not vanish with it.
    """

    __tablename__ = "workflow_cards"

    id: Mapped[uuid.UUID] = _uuid_pk()
    study_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("studies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    type: Mapped[WorkflowCardType] = mapped_column(nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    position_x: Mapped[float] = mapped_column(Float, nullable=False)
    position_y: Mapped[float] = mapped_column(Float, nullable=False)
    width: Mapped[float | None] = mapped_column(Float)
    height: Mapped[float | None] = mapped_column(Float)
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    output_case_ids: Mapped[dict | list | None] = mapped_column(JSONB)
    last_run_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    materialized_source_card_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_cards.id", ondelete="SET NULL")
    )
    materialized_source_handle: Mapped[str | None] = mapped_column(String(64))

    __table_args__ = (
        CheckConstraint("width IS NULL OR width > 0", name="ck_workflow_card_width_positive"),
        CheckConstraint("height IS NULL OR height > 0", name="ck_workflow_card_height_positive"),
    )


class WorkflowEdge(Base):
    """One directed connection between two WorkflowCards on the same
    Study's board. `study_id` is denormalized (also derivable via either
    card) purely so board-scoped queries don't need a join."""

    __tablename__ = "workflow_edges"

    id: Mapped[uuid.UUID] = _uuid_pk()
    study_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("studies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_cards.id", ondelete="CASCADE"), nullable=False
    )
    source_handle: Mapped[str] = mapped_column(String(64), nullable=False, default="output")
    target_card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_cards.id", ondelete="CASCADE"), nullable=False
    )
    target_handle: Mapped[str] = mapped_column(String(64), nullable=False, default="input")
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ClinicalDataItem(Base):
    """A generic, non-imaging piece of data attached to a Case -- a report,
    referral letter, or any other file/document. `type` is a free-form
    label rather than an enum (like AnnotationType.name), since the
    concrete set of clinical data kinds is expected to grow. The actual
    file, if any, lives in object storage; `object_storage_key` is a
    pointer, the same pattern as Instance.object_storage_key -- an item
    can also be metadata-only (object_storage_key left null).
    """

    __tablename__ = "clinical_data_items"

    id: Mapped[uuid.UUID] = _uuid_pk()
    case_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("cases.id"), nullable=False)
    date: Mapped[Date | None] = mapped_column(Date)
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    object_storage_key: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    case: Mapped["Case"] = relationship(back_populates="clinical_data_items")
    tags: Mapped[list["Tag"]] = relationship(back_populates="clinical_data_item")
    consents: Mapped[list["Consent"]] = relationship(back_populates="clinical_data_item")


class Tag(Base):
    """A free-text label on one ClinicalDataItem. Deliberately
    item-specific rather than a shared/reusable tag vocabulary."""

    __tablename__ = "tags"

    id: Mapped[uuid.UUID] = _uuid_pk()
    clinical_data_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("clinical_data_items.id"), nullable=False
    )
    label: Mapped[str] = mapped_column(String(64), nullable=False)

    clinical_data_item: Mapped["ClinicalDataItem"] = relationship(back_populates="tags")


def case_tags(case: "Case") -> list[str]:
    """Rolled-up union of tag labels across a Case's ClinicalDataItems --
    a Case has no tags of its own, only what its attached documents carry.
    Shared by data-service (case browsing) and admin-service (workflow
    board Filter cards) so both stay in lockstep with one implementation.
    """
    return sorted({tag.label for item in case.clinical_data_items for tag in item.tags})


class Consent(Base):
    """A consent record (type + granted/revoked status) on one
    ClinicalDataItem."""

    __tablename__ = "consents"

    id: Mapped[uuid.UUID] = _uuid_pk()
    clinical_data_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("clinical_data_items.id"), nullable=False
    )
    consent_type: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[ConsentStatus] = mapped_column(nullable=False)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    clinical_data_item: Mapped["ClinicalDataItem"] = relationship(back_populates="consents")


class ImagingStudy(Base):
    """One DICOM imaging study (identified by StudyInstanceUID), auto
    created/looked-up during ingestion -- not to be confused with `Study`,
    the top-level admin-created RBAC container a Case belongs to."""

    __tablename__ = "imaging_studies"

    id: Mapped[uuid.UUID] = _uuid_pk()
    case_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("cases.id"), nullable=False)
    study_instance_uid: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    study_date: Mapped[Date | None] = mapped_column(Date)
    modality: Mapped[str | None] = mapped_column(String(16))
    description: Mapped[str | None] = mapped_column(Text)
    ingested_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    case: Mapped["Case"] = relationship(back_populates="imaging_studies")
    series: Mapped[list["Series"]] = relationship(back_populates="imaging_study")


class Series(Base):
    __tablename__ = "series"

    id: Mapped[uuid.UUID] = _uuid_pk()
    imaging_study_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("imaging_studies.id"), nullable=False
    )
    series_instance_uid: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    series_number: Mapped[int | None] = mapped_column(Integer)
    body_part: Mapped[str | None] = mapped_column(String(64))
    series_description: Mapped[str | None] = mapped_column(Text)

    imaging_study: Mapped["ImagingStudy"] = relationship(back_populates="series")
    instances: Mapped[list["Instance"]] = relationship(back_populates="series")


class Instance(Base):
    """A single DICOM slice (SOP Instance). object_storage_key points at
    the raw pixel data in object storage -- the pixel bytes never live in
    Postgres."""

    __tablename__ = "instances"

    id: Mapped[uuid.UUID] = _uuid_pk()
    series_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("series.id"), nullable=False)
    sop_instance_uid: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    instance_number: Mapped[int | None] = mapped_column(Integer)
    object_storage_key: Mapped[str] = mapped_column(String(512), nullable=False)
    # A small PNG rendering of the pixel data (min-max normalized, resized),
    # generated by the ingestion worker -- lets the UI show real image
    # previews for a study/series without shipping the full DICOM file.
    thumbnail_key: Mapped[str | None] = mapped_column(String(512))
    checksum: Mapped[str | None] = mapped_column(String(128))
    rows: Mapped[int | None] = mapped_column(Integer)
    columns: Mapped[int | None] = mapped_column(Integer)
    pixel_spacing: Mapped[list | None] = mapped_column(ARRAY(Numeric))
    window_center: Mapped[float | None] = mapped_column(Numeric)
    window_width: Mapped[float | None] = mapped_column(Numeric)

    series: Mapped["Series"] = relationship(back_populates="instances")


class AnnotationType(Base):
    """A registered annotation type (e.g. "bbox", "segmentation_mask").

    New types are added by inserting a row here with a JSON Schema, not by
    changing the Annotation table -- the concrete set of types is still
    open and expected to grow.
    """

    __tablename__ = "annotation_types"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    json_schema: Mapped[dict] = mapped_column(JSONB, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, default=1)


class Annotation(Base):
    """One version of one annotation.

    Edits create a new row with parent_version_id pointing at the previous
    version rather than mutating in place -- this is the annotation-level
    audit trail. `payload` holds small geometry (points/boxes/labels)
    directly; large binary data (e.g. segmentation masks) is stored in
    object storage with just a reference inside `payload`.
    """

    __tablename__ = "annotations"

    id: Mapped[uuid.UUID] = _uuid_pk()
    # "study" here means an ImagingStudy (DICOM), not the top-level Study
    # RBAC container -- this is a free label, never joined against a table.
    target_type: Mapped[str] = mapped_column(String(16), nullable=False)  # "instance" | "series" | "study"
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    study_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("studies.id"), nullable=False)
    annotator_id: Mapped[str] = mapped_column(String(255), nullable=False)  # Keycloak "sub" claim
    type_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("annotation_types.id"), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[AnnotationStatus] = mapped_column(default=AnnotationStatus.DRAFT, nullable=False)
    parent_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("annotations.id"))
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("target_type IN ('instance','series','study')", name="ck_annotation_target_type"),
    )


class AnnotationReview(Base):
    """A reviewer's decision on a submitted annotation."""

    __tablename__ = "annotation_reviews"

    id: Mapped[uuid.UUID] = _uuid_pk()
    annotation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("annotations.id"), nullable=False)
    reviewer_id: Mapped[str] = mapped_column(String(255), nullable=False)
    decision: Mapped[str] = mapped_column(String(16), nullable=False)  # "approve" | "reject"
    comment: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DatasetSnapshot(Base):
    """An immutable, named collection of (imaging study, annotation
    version) pairs -- e.g. "v1 dataset for model training". Snapshots
    reference existing annotation rows; they never copy data."""

    __tablename__ = "dataset_snapshots"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    immutable: Mapped[bool] = mapped_column(Boolean, default=True)


class DatasetSnapshotItem(Base):
    __tablename__ = "dataset_snapshot_items"

    snapshot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("dataset_snapshots.id"), primary_key=True
    )
    imaging_study_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("imaging_studies.id"), primary_key=True
    )
    annotation_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("annotations.id"), primary_key=True
    )


class AuditLog(Base):
    """General-purpose audit trail for admin actions (user/study/profile
    changes) that fall outside the annotation-specific history chain."""

    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = _uuid_pk()
    actor_id: Mapped[str] = mapped_column(String(255), nullable=False)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    diff: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())
