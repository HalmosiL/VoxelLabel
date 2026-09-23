"""usage: element anchors, study and structure key on screen snapshots

Lets a click be placed on the same element of a screen whatever that
screen's layout was when it was clicked (anchors), pictures be chosen
per study, and a new picture be taken when a screen's structure changes
(structure_key).

Revision ID: a4b6c8d0e2f4
Revises: f3a5b7c9d1e3
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "a4b6c8d0e2f4"
down_revision = "f3a5b7c9d1e3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("usage_snapshots", sa.Column("anchors", JSONB()))
    op.add_column("usage_snapshots", sa.Column("study_id", sa.String(64)))
    op.add_column("usage_snapshots", sa.Column("structure_key", sa.String(64)))
    op.create_index("ix_usage_snapshots_study", "usage_snapshots", ["study_id"])


def downgrade() -> None:
    op.drop_index("ix_usage_snapshots_study", table_name="usage_snapshots")
    op.drop_column("usage_snapshots", "structure_key")
    op.drop_column("usage_snapshots", "study_id")
    op.drop_column("usage_snapshots", "anchors")
