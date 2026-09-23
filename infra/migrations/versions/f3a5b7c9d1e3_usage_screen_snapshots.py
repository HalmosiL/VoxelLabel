"""usage: screen snapshots behind the heatmap and replay

usage_snapshots holds one screen's HTML as someone saw it (images
replaced by placeholders, scripts and typed values removed), gzipped;
usage_snapshot_styles its stylesheets, once per content hash.

Revision ID: f3a5b7c9d1e3
Revises: e2f4a6b8c0d2
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "f3a5b7c9d1e3"
down_revision = "e2f4a6b8c0d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "usage_snapshots",
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
    )
    op.create_index("ix_usage_snapshots_route_occurred", "usage_snapshots", ["route", "occurred_at"])
    op.create_index("ix_usage_snapshots_session", "usage_snapshots", ["session_id"])
    op.create_table(
        "usage_snapshot_styles",
        sa.Column("css_hash", sa.String(64), primary_key=True),
        sa.Column("css_gz", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("usage_snapshot_styles")
    op.drop_index("ix_usage_snapshots_session", table_name="usage_snapshots")
    op.drop_index("ix_usage_snapshots_route_occurred", table_name="usage_snapshots")
    op.drop_table("usage_snapshots")
