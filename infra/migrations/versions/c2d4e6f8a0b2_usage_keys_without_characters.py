"""usage: forget which characters were typed

Key events stored the typed character, so text typed while focus was not
in a field (a missed click on the comment box) was kept letter by letter
(K1). The tracker and the ingest now store a plain character as "char";
this rewrites the rows already stored the same way. Irreversible on
purpose: the characters are not kept anywhere.

Revision ID: c2d4e6f8a0b2
Revises: b1c3d5e7f9a1
"""
from alembic import op

revision = "c2d4e6f8a0b2"
down_revision = "b1c3d5e7f9a1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE usage_events SET name = 'char' WHERE event_type = 'key' "
        "AND name ~ '^(Shift\\+)?.$' AND name <> ' '"
    )
    op.execute("UPDATE usage_events_archive SET name = 'char' WHERE event_type = 'key' AND name ~ '^(Shift\\+)?.$' AND name <> ' '")


def downgrade() -> None:
    pass  # the characters are gone for good
