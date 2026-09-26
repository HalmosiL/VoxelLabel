"""studies: a trash

Deleting a study from the UI removed it and everything in it at once, with
no way back (UX K2). A deleted study now goes to the trash first: it keeps
its data, is hidden everywhere, and can be restored or deleted for good.

Revision ID: e5f7a9b1c3d5
Revises: d4e6f8a0b2c4
"""
import sqlalchemy as sa
from alembic import op

revision = "e5f7a9b1c3d5"
down_revision = "d4e6f8a0b2c4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("studies", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("studies", sa.Column("deleted_by", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("studies", "deleted_by")
    op.drop_column("studies", "deleted_at")
