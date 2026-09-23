"""usage: clearing the usage log into a restorable archive

usage_clears records each "clear the usage log"; the events and screen
snapshots it took out of the live tables wait in usage_events_archive /
usage_snapshots_archive (same columns, plus the clear's id) until they
are restored or deleted for good.

Revision ID: b5c7d9e1f3a5
Revises: a4b6c8d0e2f4
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "b5c7d9e1f3a5"
down_revision = "a4b6c8d0e2f4"
branch_labels = None
depends_on = None


def _clear_fk() -> sa.Column:
    return sa.Column("clear_id", UUID(as_uuid=True), sa.ForeignKey("usage_clears.id", ondelete="CASCADE"), nullable=False)


def upgrade() -> None:
    op.create_table(
        "usage_clears",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("cleared_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("cleared_by", sa.String(255), nullable=False),
        sa.Column("events", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("snapshots", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("first_at", sa.DateTime(timezone=True)),
        sa.Column("last_at", sa.DateTime(timezone=True)),
        sa.Column("restored_at", sa.DateTime(timezone=True)),
        sa.Column("restored_by", sa.String(255)),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column("deleted_by", sa.String(255)),
    )
    op.create_table(
        "usage_events_archive",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", sa.String(255), nullable=False),
        sa.Column("session_id", sa.String(64), nullable=False),
        sa.Column("app", sa.String(16), nullable=False),
        sa.Column("event_type", sa.String(16), nullable=False),
        sa.Column("app_version", sa.String(40)),
        sa.Column("route", sa.String(255), nullable=False),
        sa.Column("name", sa.String(64)),
        sa.Column("detail", JSONB()),
        sa.Column("duration_ms", sa.Integer()),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        _clear_fk(),
    )
    op.create_index("ix_usage_events_archive_clear", "usage_events_archive", ["clear_id"])
    op.create_index("ix_usage_events_archive_occurred", "usage_events_archive", ["occurred_at"])
    op.create_table(
        "usage_snapshots_archive",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", sa.String(255), nullable=False),
        sa.Column("session_id", sa.String(64), nullable=False),
        sa.Column("app", sa.String(16), nullable=False),
        sa.Column("app_version", sa.String(40)),
        sa.Column("route", sa.String(255), nullable=False),
        sa.Column("job_id", sa.String(64)),
        sa.Column("viewport_w", sa.Integer(), nullable=False),
        sa.Column("viewport_h", sa.Integer(), nullable=False),
        sa.Column("html_gz", sa.LargeBinary(), nullable=False),
        sa.Column("css_hash", sa.String(64)),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("anchors", JSONB()),
        sa.Column("study_id", sa.String(64)),
        sa.Column("structure_key", sa.String(64)),
        _clear_fk(),
    )
    op.create_index("ix_usage_snapshots_archive_clear", "usage_snapshots_archive", ["clear_id"])
    op.create_index("ix_usage_snapshots_archive_occurred", "usage_snapshots_archive", ["occurred_at"])


def downgrade() -> None:
    op.drop_table("usage_snapshots_archive")
    op.drop_table("usage_events_archive")
    op.drop_table("usage_clears")
