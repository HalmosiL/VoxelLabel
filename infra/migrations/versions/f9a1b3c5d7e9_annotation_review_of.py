"""annotations: review_of_id -- a reviewer's draft points at the version it reviews

A reviewer's "Save" while reviewing created a plain DRAFT that became the
case's latest version: the handed-in case showed as not annotated again
and had nothing left to decide (F-01). Such drafts now record the
SUBMITTED version they review, and only handed-in work can be decided
(F-07, F-09).

Revision ID: f9a1b3c5d7e9
Revises: e8f0a2b4c6d8
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "f9a1b3c5d7e9"
down_revision = "e8f0a2b4c6d8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("annotations", sa.Column("review_of_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "annotations_review_of_id_fkey", "annotations", "annotations", ["review_of_id"], ["id"], ondelete="SET NULL"
    )


def downgrade() -> None:
    op.drop_constraint("annotations_review_of_id_fkey", "annotations", type_="foreignkey")
    op.drop_column("annotations", "review_of_id")
