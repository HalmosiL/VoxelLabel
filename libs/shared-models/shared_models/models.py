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


class ProjectRole(str, enum.Enum):
    """Roles a user can hold on a given project, via ProjectMembership."""

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


class Project(Base):
    """A project scopes data access: every case belongs to exactly one
    project, and per-project roles are granted via ProjectMembership."""

    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    deidentification_profile_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("deidentification_profiles.id")
    )
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    memberships: Mapped[list["ProjectMembership"]] = relationship(back_populates="project")
    cases: Mapped[list["Case"]] = relationship(back_populates="project")


class ProjectMembership(Base):
    """Grants a Keycloak user a role scoped to one project.

    A global Keycloak realm role of "admin" bypasses this table entirely
    (see shared_auth.require_project_role) -- this table is only consulted
    for non-global-admin, project-scoped access decisions.
    """

    __tablename__ = "project_memberships"

    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(255), primary_key=True)  # Keycloak "sub" claim
    role: Mapped[ProjectRole] = mapped_column(nullable=False)

    project: Mapped["Project"] = relationship(back_populates="memberships")


class DeidentificationProfile(Base):
    """An admin-editable, named set of de-identification rules.

    Assigned to a Project via Project.deidentification_profile_id. The rules
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
    project a body of data belongs to; both imaging (Study -> Series ->
    Instance) and non-imaging (ClinicalDataItem) data hang off a Case
    rather than referencing Project/Patient directly, so "everything
    belonging to this patient's episode" has one place to attach to,
    regardless of kind. See ARCHITECTURE.md, "Case-centric data model".
    """

    __tablename__ = "cases"

    id: Mapped[uuid.UUID] = _uuid_pk()
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
    patient_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("patients.id"), nullable=False)
    accession_number: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped["Project"] = relationship(back_populates="cases")
    patient: Mapped["Patient"] = relationship(back_populates="cases")
    studies: Mapped[list["Study"]] = relationship(back_populates="case")
    clinical_data_items: Mapped[list["ClinicalDataItem"]] = relationship(back_populates="case")


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


class Study(Base):
    __tablename__ = "studies"

    id: Mapped[uuid.UUID] = _uuid_pk()
    case_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("cases.id"), nullable=False)
    study_instance_uid: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    study_date: Mapped[Date | None] = mapped_column(Date)
    modality: Mapped[str | None] = mapped_column(String(16))
    description: Mapped[str | None] = mapped_column(Text)
    ingested_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    case: Mapped["Case"] = relationship(back_populates="studies")
    series: Mapped[list["Series"]] = relationship(back_populates="study")


class Series(Base):
    __tablename__ = "series"

    id: Mapped[uuid.UUID] = _uuid_pk()
    study_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("studies.id"), nullable=False)
    series_instance_uid: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    series_number: Mapped[int | None] = mapped_column(Integer)
    body_part: Mapped[str | None] = mapped_column(String(64))
    series_description: Mapped[str | None] = mapped_column(Text)

    study: Mapped["Study"] = relationship(back_populates="series")
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
    target_type: Mapped[str] = mapped_column(String(16), nullable=False)  # "instance" | "series" | "study"
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False)
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
    """An immutable, named collection of (study, annotation version) pairs
    -- e.g. "v1 dataset for model training". Snapshots reference existing
    annotation rows; they never copy data."""

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
    study_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("studies.id"), primary_key=True)
    annotation_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("annotations.id"), primary_key=True
    )


class AuditLog(Base):
    """General-purpose audit trail for admin actions (user/project/profile
    changes) that fall outside the annotation-specific history chain."""

    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = _uuid_pk()
    actor_id: Mapped[str] = mapped_column(String(255), nullable=False)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    diff: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())
