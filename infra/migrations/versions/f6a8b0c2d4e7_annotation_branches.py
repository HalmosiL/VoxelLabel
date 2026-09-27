"""annotations: branches (independent version chains of one image)

A Duplicate workflow card sends the same cases down several lanes, each
annotated apart so annotators can be compared on the same image. Each lane
saves on its own branch; null is the main chain every existing version is on.

Revision ID: f6a8b0c2d4e7
Revises: e5f7a9b1c3d5
"""
import sqlalchemy as sa
from alembic import op

revision = "f6a8b0c2d4e7"
down_revision = "e5f7a9b1c3d5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("annotations", sa.Column("branch", sa.String(128), nullable=True))
    op.create_index("ix_annotations_target_branch", "annotations", ["target_type", "target_id", "branch"])


def downgrade() -> None:
    op.drop_index("ix_annotations_target_branch", table_name="annotations")
    op.drop_column("annotations", "branch")
