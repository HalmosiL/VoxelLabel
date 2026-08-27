"""add llm workflow card type

Revision ID: c2f6a9d4b8e1
Revises: f7c3d8a1e2b5
Create Date: 2026-08-26 09:00:00.000000
"""
from alembic import op

revision = 'c2f6a9d4b8e1'
down_revision = 'f7c3d8a1e2b5'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # See a1c4e2f97b3d for why this needs its own autocommit block. The
    # Clinical Trial module's mocked-LLM card (see WorkflowCardType.LLM's
    # docstring in models.py) -- pure configuration/chat state, same as
    # every other card type, so no other schema change is needed here.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE workflowcardtype ADD VALUE 'LLM'")


def downgrade() -> None:
    raise NotImplementedError(
        "Downgrading past this migration requires manually rebuilding the "
        "workflowcardtype enum without LLM -- not implemented, since "
        "there's no safe automatic way to do it once rows may reference it."
    )
