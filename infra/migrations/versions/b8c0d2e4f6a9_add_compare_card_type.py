"""workflow cards: Compare (inputs' work on the same images, side by side)

Revision ID: b8c0d2e4f6a9
Revises: a7b9c1d3e5f8
"""
from alembic import op

revision = "b8c0d2e4f6a9"
down_revision = "a7b9c1d3e5f8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE workflowcardtype ADD VALUE IF NOT EXISTS 'COMPARE'")


def downgrade() -> None:
    raise NotImplementedError("COMPARE can't be removed from workflowcardtype")
