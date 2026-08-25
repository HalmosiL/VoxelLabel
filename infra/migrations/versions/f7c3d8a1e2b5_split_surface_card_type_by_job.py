"""split surface workflow card type by job (annotation vs review)

Revision ID: f7c3d8a1e2b5
Revises: a1c4e2f97b3d
Create Date: 2026-08-25 09:00:00.000000
"""
from alembic import op

revision = 'f7c3d8a1e2b5'
down_revision = 'a1c4e2f97b3d'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # See a1c4e2f97b3d for why this needs its own autocommit block.
    # SURFACE itself is left in place (superseded, not removed -- see
    # its docstring in models.py); any existing SURFACE rows are moved
    # to ANNOTATION_SURFACE/REVIEW_SURFACE by a one-off data script, not
    # by this schema migration.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE workflowcardtype ADD VALUE 'ANNOTATION_SURFACE'")
        op.execute("ALTER TYPE workflowcardtype ADD VALUE 'REVIEW_SURFACE'")


def downgrade() -> None:
    raise NotImplementedError(
        "Downgrading past this migration requires manually rebuilding the "
        "workflowcardtype enum without ANNOTATION_SURFACE/REVIEW_SURFACE -- "
        "not implemented, since there's no safe automatic way to do it once "
        "rows may reference them."
    )
