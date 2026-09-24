"""SQLAlchemy ORM models for the CT annotation platform.

This module is the single source of truth for the database schema. It is
shared (as an installable local package) across all services -- ingestion,
data, annotation, admin -- and by the Alembic migrations in
infra/migrations. Do not duplicate table definitions in a service; import
them from here instead.
"""
import enum
import secrets
import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
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
    # Superseded by ANNOTATION_SURFACE/REVIEW_SURFACE below -- kept only
    # because a Postgres enum value can't be cleanly dropped once it may
    # have live rows. No new card is ever created with this type; do not
    # reference it in new code.
    SURFACE = "surface"
    # Pure configuration, never part of the case-flow graph: connects to
    # one Annotation card (via the "surface_config" edge handle, not the
    # ordinary data "input") to mandatorily restrict which ct-annotator
    # tools/panes/3D are available while working that job. See
    # app/api/workflow.py's get_surface_config.
    ANNOTATION_SURFACE = "annotation_surface"
    # Same idea, but for a Review card -- and deliberately a distinct
    # type rather than reusing ANNOTATION_SURFACE, because the two jobs'
    # surfaces are shaped differently: the review surface (see
    # ct-annotator's ViewerPage reviewMode) has no tools and no 3D at
    # all, unconditionally, so a review-only card only ever configures
    # which MPR panes are visible -- exposing tools/show_3d checkboxes
    # for it would just be dead UI.
    REVIEW_SURFACE = "review_surface"
    # The Clinical Trial module: a small local model (served by Ollama)
    # connected, via a real MCP server (services/mcp-server), to
    # whichever Dataset(s) are wired into its "input" -- its
    # "config.messages" is the real chat transcript, and a session can
    # spawn a brand-new, ordinary Dataset card as a named materialized
    # child (see _materialized_children), exactly like Split's parts or
    # Review's approved/rejected branches. See app/llm_client.py's
    # run_llm_turn and app/api/workflow.py's llm_chat.
    LLM = "llm"
    # Same module, a different role: plans a study's CONSORT-style
    # eligibility pipeline and builds it on the real board -- no input/
    # output of its own (scoped to the whole Study, not to connected
    # data), its tools create Dataset and CRITERION cards and wire them
    # together. See llm_client.py's BUILDER branch.
    BUILDER = "builder"
    # One eligibility criterion, judged case by case by the same small
    # model -- "config.criterion" holds the one natural-language rule it
    # applies. Structurally like REVIEW (one real input, no real output,
    # always materializes two named children) but the two branches are
    # "included"/"excluded" rather than "approved"/"rejected". Chaining
    # criterion cards one after another (each wired from the previous
    # one's "included" child) is what makes the board itself read as a
    # CONSORT flow diagram.
    CRITERION = "criterion"


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

    `role` is part of the primary key, not a single mutable column, so
    one user can hold *more than one* role in the same study at once
    (e.g. both annotator and reviewer) -- one row per (study, user,
    role). "Change this member's role" is therefore add one row + remove
    another, not an update; see admin-service's add_study_member /
    remove_study_member.

    A global Keycloak realm role of "admin" bypasses this table entirely
    (see shared_auth.require_study_role) -- this table is only consulted
    for non-global-admin, study-scoped access decisions.
    """

    __tablename__ = "study_memberships"

    study_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("studies.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(255), primary_key=True)  # Keycloak "sub" claim
    role: Mapped[StudyRole] = mapped_column(primary_key=True)

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
    # Secret key of the profile's "hash" rules (see shared_models.deid_rules):
    # without it, a short identifier's hash can be reversed by trying every
    # candidate. Never returned by the API.
    hash_salt: Mapped[str] = mapped_column(String(64), nullable=False, default=lambda: secrets.token_hex(32))

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


class PipelineTemplate(Base):
    """A reusable, ready-made pipeline (a small set of workflow cards +
    the edges between them) that can be dropped onto any Study's board
    at once -- the Store panel on the workflow board (see admin-ui's
    PipelineStore). Global, not scoped to a Study, since the whole point
    is reusing the same pipeline shape across studies.

    `cards`/`edges` mirror admin-ui's own PipelineTemplate shape exactly
    (a list of {key, type, title, x, y, width, height, config} dicts and
    {source_key, source_handle, target_key, target_handle} dicts) --
    `key` is a local reference scoped to this one template, not a real
    WorkflowCard id, resolved fresh into real ids each time it's
    inserted (see admin-service's own insert-time logic, which mirrors
    the frontend's built-in templates in pipelineTemplates.ts). Kept as
    opaque JSONB rather than normalized tables since nothing ever
    queries into one template's own cards/edges except "give me the
    whole thing to insert" -- the same reasoning as WorkflowCard.config.
    """

    __tablename__ = "pipeline_templates"

    id: Mapped[uuid.UUID] = _uuid_pk()
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    cards: Mapped[list] = mapped_column(JSONB, nullable=False)
    edges: Mapped[list] = mapped_column(JSONB, nullable=False)
    # The Keycloak subject that saved this template -- lets its own
    # author delete it without needing the global "admin" realm role
    # (see delete_pipeline_template); nullable because a future
    # platform-seeded template (inserted directly, not through the API)
    # has no such author.
    created_by: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())


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


class StudyVersion(Base):
    """A point-in-time snapshot of everything that makes up a Study's
    *configuration*: the study's own fields, its memberships, the whole
    workflow board (cards with their config/run state, edges) and every
    case's editable metadata. Recorded automatically after each change
    (coalesced -- see admin-service's app/versioning.py) and on demand
    with a label, so any earlier state can be inspected and restored.
    Deliberately excludes clinical payload data (DICOM instances,
    documents, annotations): those are never rewritten by a restore --
    a restore re-shapes the study around them, it never deletes them."""

    __tablename__ = "study_versions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    study_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("studies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 1, 2, 3 ... per study -- what people refer to ("restore v12").
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    # "auto" (recorded after a change), "manual" (saved with a label), or
    # "pre_restore" (the safety copy taken right before a restore).
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="auto")
    label: Mapped[str | None] = mapped_column(String(255))
    created_by: Mapped[str] = mapped_column(String(255), nullable=False)  # Keycloak "sub" claim
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    # Small counts (cards/edges/members/cases) for the version list, so
    # listing versions never has to load every snapshot.
    summary: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)



# ── Notification service (see admin-service's app/notifications) ─────────


class NotificationSettings(Base):
    """The platform's one email-delivery configuration (a single row,
    id=1): where to send mail through and whether the notification
    service is switched on at all. Kept in the database rather than env
    vars so a platform admin can change it -- and send a test email --
    from the admin UI without a redeploy."""

    __tablename__ = "notification_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    smtp_host: Mapped[str] = mapped_column(String(255), nullable=False, default="mailpit")
    smtp_port: Mapped[int] = mapped_column(Integer, nullable=False, default=1025)
    smtp_username: Mapped[str | None] = mapped_column(String(255))
    smtp_password: Mapped[str | None] = mapped_column(String(255))
    # STARTTLS on a plain connection vs. an implicit-TLS (SMTPS) socket.
    smtp_use_tls: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    smtp_use_ssl: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    from_address: Mapped[str] = mapped_column(String(255), nullable=False, default="VoxelLabel <no-reply@voxellabel.local>")
    # Where the links in emails point (the admin-ui/workbench origin).
    platform_base_url: Mapped[str] = mapped_column(String(512), nullable=False, default="http://localhost:5173")
    poll_interval_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    # When the observer first ran. Its first cycle records the current
    # state silently instead of emailing about every job as if it had just
    # appeared; this marks that the silent cycle has happened. (An empty
    # job_notification_state table can't be the marker: with no cards yet
    # it stays empty, and the first card ever created would then be
    # swallowed by a second "first" cycle.)
    first_observed_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class NotificationPreference(Base):
    """One user's opt-in/out for each kind of email. A user with no row
    gets every kind (the defaults below) -- rows only exist once someone
    changes something."""

    __tablename__ = "notification_preferences"

    user_id: Mapped[str] = mapped_column(String(255), primary_key=True)  # Keycloak "sub" claim
    email_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    notify_new_job: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    notify_status_change: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    updated_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class JobNotificationState(Base):
    """What the notification service last saw for one Annotation/Review
    card -- its assignee, computed status and every case's state. A
    job's status is derived on read, not written (see admin-service's
    compute_job_status), so there is no single write path to hook; the
    service instead re-derives all of this on a timer and treats any
    difference from this row as the event to notify about."""

    __tablename__ = "job_notification_state"

    card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_cards.id", ondelete="CASCADE"), primary_key=True
    )
    assigned_user_id: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    # {case_id: state} -- see admin-service's job_case_states for the values.
    # Observed for completeness; only job-level changes are emailed.
    case_states: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    observed_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class NotificationLog(Base):
    """Every email the notification service decided about -- sent,
    failed (with the SMTP error) or skipped (with why: delivery off, the
    user opted out, no email address on their account). The admin UI's
    delivery log. No FK to the card: the record should outlive it."""

    __tablename__ = "notification_log"

    id: Mapped[uuid.UUID] = _uuid_pk()
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str | None] = mapped_column(String(255))
    # "job_assigned", "job_status_changed", "test"
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    card_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # "sent" | "failed" | "skipped"
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    error: Mapped[str | None] = mapped_column(Text)


class RegistrationRequest(Base):
    """A self-service "I'd like an account" submission from the public
    registration page -- no Keycloak user exists yet. An admin reviews
    it on the Users page; approving creates the real account (with a
    random temporary password, same as the admin's own "create user"
    flow) and emails the person their credentials, rejecting just tells
    them no. Kept even after a decision, as the audit trail of who
    asked and who decided."""

    __tablename__ = "registration_requests"

    id: Mapped[uuid.UUID] = _uuid_pk()
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    username: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    first_name: Mapped[str] = mapped_column(String(255), nullable=False)
    last_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Free-text "why do you need access" the requester can add -- shown
    # to the admin, never required.
    note: Mapped[str | None] = mapped_column(Text)
    # "pending" | "approved" | "rejected"
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending", index=True)
    decided_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True))
    decided_by: Mapped[str | None] = mapped_column(String(255))  # the admin's Keycloak subject
    rejection_reason: Mapped[str | None] = mapped_column(Text)


class UsageEventFields:
    """The columns of a usage event -- shared by the live table and its
    archive (UsageEventArchive), so the two can never drift apart."""

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    # Per browser tab, generated client-side; groups one sitting.
    session_id: Mapped[str] = mapped_column(String(64), nullable=False)
    # "admin-ui" | "viewer"
    app: Mapped[str] = mapped_column(String(16), nullable=False)
    # page_view | page_leave | action | click | mouse_trace | scroll |
    # key | focus | idle | error
    event_type: Mapped[str] = mapped_column(String(16), nullable=False)
    # Build of the app that sent it (package version + build stamp, or
    # the CI commit) -- what makes "did this release help?" answerable.
    app_version: Mapped[str | None] = mapped_column(String(40))
    # Normalised path -- UUID segments replaced by ":id", no query string.
    route: Mapped[str] = mapped_column(String(255), nullable=False)
    # Action/tool/key name ("tool.paint", "mark_annotated", "Ctrl+z").
    name: Mapped[str | None] = mapped_column(String(64))
    # Whitelisted keys only: study_id/case_id/job_id/series_id, x, y,
    # target, points [[t, x, y], ...], depth, viewport [w, h], message.
    detail: Mapped[dict | None] = mapped_column(JSONB)
    # page_leave: how long the page was open; idle: how long nothing
    # happened.
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    # The client's clock, so ordering within a session is exact even
    # when a batch is flushed late.
    occurred_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class UsageEvent(UsageEventFields, Base):
    """One thing a signed-in person did in admin-ui or the viewer -- a
    page opened/left (with how long it stayed open), a curated action
    (a viewer tool picked, Mark as Annotated, Submit review...), a click,
    a sampled mouse trace, scroll depth, a keyboard shortcut, focus/idle
    and JS errors. Recorded for every user so the Usage page can show
    how the product is really used; `user_id` is always the caller's
    own token subject, never something the client sent. Carries internal
    ids only (study/case/series/job) -- never patient data or typed text.
    Deliberately separate from `AuditLog`, which is the compliance record
    of admin *state changes*; this is UX research data with a retention
    limit (see usage_settings.retention_days)."""

    __tablename__ = "usage_events"
    __table_args__ = (
        Index("ix_usage_events_user_occurred", "user_id", "occurred_at"),
        Index("ix_usage_events_occurred", "occurred_at"),
        Index("ix_usage_events_session", "session_id"),
        Index("ix_usage_events_type_occurred", "event_type", "occurred_at"),
    )


class UsageSettings(Base):
    """The recording switches for usage tracking (a single row, id=1):
    a master switch, one per data category, the mouse sampling rate,
    how long events are kept, and which users are excluded. In the
    database rather than env vars so a platform admin flips them from
    the Usage page and every open tab picks the change up on its next
    config poll -- no redeploy."""

    __tablename__ = "usage_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    track_pages: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    track_actions: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    track_clicks: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    track_mouse: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    track_scroll: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    track_keys: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    track_errors: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Request timings the browser measured (per API endpoint, aggregated).
    track_perf: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    # Let screen snapshots carry the case images (the CT slices as shown,
    # small inline pictures) instead of grey blocks. Off by default: it is
    # image data, and far bigger.
    track_screen_images: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # Ask "how demanding was that case?" after every n-th finished case
    # (0 = never). One click, skippable -- the only direct measure of
    # cognitive load; every n-th, not every case, to keep the cost low.
    rating_every_n: Mapped[int] = mapped_column(Integer, nullable=False, default=3, server_default="3")
    # How often a moving mouse is sampled into a trace, in milliseconds.
    mouse_sample_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    # Events older than this are purged (mouse traces are bulky).
    retention_days: Mapped[int] = mapped_column(Integer, nullable=False, default=90)
    # Keycloak subjects excluded from recording; empty = everyone.
    disabled_user_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # Keycloak subjects still recorded but left out of every figure on
    # the Usage page (test and demo accounts) -- and whether accounts
    # holding the global admin role are left out too. Admins configure
    # and click around the platform; counting them skews every
    # "how do people work" number toward administration.
    excluded_user_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    exclude_admins: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    updated_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class UsageSnapshotFields:
    """The columns of a screen snapshot -- shared by the live table and
    its archive (UsageSnapshotArchive)."""

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    session_id: Mapped[str] = mapped_column(String(64), nullable=False)
    app: Mapped[str] = mapped_column(String(16), nullable=False)
    app_version: Mapped[str | None] = mapped_column(String(40))
    route: Mapped[str] = mapped_column(String(255), nullable=False)
    # the job the screen was opened from (viewer), to tell annotation from review
    job_id: Mapped[str | None] = mapped_column(String(64))
    viewport_w: Mapped[int] = mapped_column(Integer, nullable=False)
    viewport_h: Mapped[int] = mapped_column(Integer, nullable=False)
    html_gz: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    css_hash: Mapped[str | None] = mapped_column(String(64))
    occurred_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Where each identifiable element was on this screen: [[descriptor,
    # x, y, w, h], ...] -- what lets a click recorded on another screen
    # (more objects in a list, a pane hidden, another window size) be put
    # on the same element in this picture.
    anchors: Mapped[list | None] = mapped_column(JSONB)
    # The study the screen belonged to, and a hash of which identifiable
    # elements were visible (a pane switched off changes it) -- a new
    # snapshot is taken whenever that changes.
    study_id: Mapped[str | None] = mapped_column(String(64))
    structure_key: Mapped[str | None] = mapped_column(String(64))
    # Whether the case images came along (track_screen_images was on).
    has_images: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")


class UsageSnapshot(UsageSnapshotFields, Base):
    """A picture of one screen as someone saw it -- its HTML with every
    image, canvas and video swapped for a grey placeholder, scripts and
    typed values removed (see the tracker's captureSnapshot) -- drawn
    behind the click heatmap and the session replay in a sandboxed
    iframe. Stylesheets are stored once per content hash
    (UsageSnapshotStyle). Kept per screen up to a cap, and purged with
    the usage events."""

    __tablename__ = "usage_snapshots"
    __table_args__ = (
        Index("ix_usage_snapshots_route_occurred", "route", "occurred_at"),
        Index("ix_usage_snapshots_session", "session_id"),
    )


class UsageSnapshotStyle(Base):
    """One app build's stylesheets, stored once, shared by its snapshots."""

    __tablename__ = "usage_snapshot_styles"

    css_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    css_gz: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class UsageClear(Base):
    """One "clear the usage log": every usage event and screen snapshot
    that existed at that moment, moved (not deleted) into the archive
    tables under this id, so it can be put back with a restore -- or
    deleted for good. The row itself stays as the record of who cleared,
    restored or deleted what, and when. Archived rows still fall under
    usage_settings.retention_days: the trash never keeps data longer
    than the live log would have."""

    __tablename__ = "usage_clears"

    id: Mapped[uuid.UUID] = _uuid_pk()
    cleared_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    cleared_by: Mapped[str] = mapped_column(String(255), nullable=False)
    # What was moved, at the moment of the clear.
    events: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    snapshots: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # The span of the moved events' own times.
    first_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True))
    last_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True))
    restored_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True))
    restored_by: Mapped[str | None] = mapped_column(String(255))
    deleted_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True))
    deleted_by: Mapped[str | None] = mapped_column(String(255))


class UsageEventArchive(UsageEventFields, Base):
    """Usage events taken out of the live log by a clear (UsageClear)."""

    __tablename__ = "usage_events_archive"
    __table_args__ = (
        Index("ix_usage_events_archive_clear", "clear_id"),
        Index("ix_usage_events_archive_occurred", "occurred_at"),
    )

    clear_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("usage_clears.id", ondelete="CASCADE"), nullable=False)


class UsageSnapshotArchive(UsageSnapshotFields, Base):
    """Screen snapshots taken out of the live log by a clear (UsageClear).
    Their stylesheets stay in usage_snapshot_styles meanwhile."""

    __tablename__ = "usage_snapshots_archive"
    __table_args__ = (
        Index("ix_usage_snapshots_archive_clear", "clear_id"),
        Index("ix_usage_snapshots_archive_occurred", "occurred_at"),
    )

    clear_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("usage_clears.id", ondelete="CASCADE"), nullable=False)


class CaseStageEvent(Base):
    """The one fact `WorkflowCard.output_case_ids` (a plain JSONB list,
    overwritten on every Run, no history) can't answer on its own: when
    did a case actually become available in an Annotation/Review card's
    queue. Recorded once, going forward, at the end of that card's own
    Run (see engine.py's _run_annotation/_run_review) for every case_id
    that doesn't already have a row here -- idempotent by construction,
    so it's correct regardless of ripple/re-Run ordering, and a case
    removed then re-added keeps its original queue-start rather than
    looking freshly arrived.

    Neither an audit trail of *who* changed *what* (AuditLog) nor a
    record of *how* someone used the UI (UsageEvent) -- this is the
    pipeline's own clock, the basis for cycle-time and bottleneck
    reporting (see app/pipeline_health). Every other timestamp that
    reporting needs (Annotation.created_at, AnnotationReview.created_at)
    already exists and is exact; this table exists only to fill the one
    genuine gap."""

    __tablename__ = "case_stage_events"
    __table_args__ = (
        UniqueConstraint("card_id", "case_id", name="uq_case_stage_events_card_case"),
        Index("ix_case_stage_events_study_occurred", "study_id", "occurred_at"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    study_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    card_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("workflow_cards.id", ondelete="CASCADE"), nullable=False)
    case_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("cases.id", ondelete="CASCADE"), nullable=False)
    occurred_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
