"""add surface workflow card type

Revision ID: a1c4e2f97b3d
Revises: 6385e1634981
Create Date: 2026-08-24 10:00:00.000000
"""
from alembic import op


revision = 'a1c4e2f97b3d'
down_revision = '6385e1634981'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Postgres can't ALTER TYPE ... ADD VALUE inside the same transaction
    # as other DDL (and the new value can't be used within the same
    # transaction it's added in) -- this migration does nothing else, and
    # runs the ALTER in its own autocommit block so it takes effect
    # immediately.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE workflowcardtype ADD VALUE 'SURFACE'")


def downgrade() -> None:
    # Postgres has no ALTER TYPE ... DROP VALUE -- removing an enum value
    # requires rebuilding the type (rename old, create new, cast every
    # column, drop old), not worth it for a downgrade path on a type with
    # no rows using it yet if this is rolled back immediately after
    # upgrading. If SURFACE cards already exist by the time this would be
    # downgraded, delete/re-type them first.
    raise NotImplementedError(
        "Downgrading past this migration requires manually rebuilding the "
        "workflowcardtype enum without SURFACE -- not implemented, since "
        "there's no safe automatic way to do it once rows may reference it."
    )
