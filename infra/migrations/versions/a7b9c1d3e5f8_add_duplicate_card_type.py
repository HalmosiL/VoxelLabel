"""workflow cards: Duplicate (the same cases down several lanes)

Revision ID: a7b9c1d3e5f8
Revises: f6a8b0c2d4e7
"""
from alembic import op

revision = "a7b9c1d3e5f8"
down_revision = "f6a8b0c2d4e7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ALTER TYPE ... ADD VALUE can't run inside a transaction block
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE workflowcardtype ADD VALUE IF NOT EXISTS 'DUPLICATE'")


def downgrade() -> None:
    # a Postgres enum value can't be dropped while rows may use it
    raise NotImplementedError("DUPLICATE can't be removed from workflowcardtype")
