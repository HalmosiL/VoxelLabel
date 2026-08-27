"""add builder and criterion workflow card types

Revision ID: e5a17b3c9f42
Revises: c2f6a9d4b8e1
Create Date: 2026-08-26 15:00:00.000000
"""
from alembic import op

revision = 'e5a17b3c9f42'
down_revision = 'c2f6a9d4b8e1'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # See a1c4e2f97b3d for why this needs its own autocommit block. The
    # Clinical Trial module's Pipeline Builder + per-criterion sub-agent
    # cards (see WorkflowCardType.BUILDER/CRITERION's docstrings in
    # models.py).
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE workflowcardtype ADD VALUE 'BUILDER'")
        op.execute("ALTER TYPE workflowcardtype ADD VALUE 'CRITERION'")


def downgrade() -> None:
    raise NotImplementedError(
        "Downgrading past this migration requires manually rebuilding the "
        "workflowcardtype enum without BUILDER/CRITERION -- not implemented, "
        "since there's no safe automatic way to do it once rows may reference them."
    )
