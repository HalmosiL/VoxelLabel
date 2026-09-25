"""pipeline health: a case's queue-start outlives a deleted card

Undoing a card delete, or restoring a study version, brings the card back
with its original id, but its cases' queue-start rows had been
cascade-deleted with it, so cycle time and bottlenecks lost those cases
for good (I-04). The rows are now kept (no foreign key to the card); they
still go with their case.

Revision ID: b1c3d5e7f9a1
Revises: a0b2c4d6e8f0
"""
from alembic import op

revision = "b1c3d5e7f9a1"
down_revision = "a0b2c4d6e8f0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("case_stage_events_card_id_fkey", "case_stage_events", type_="foreignkey")


def downgrade() -> None:
    op.execute("DELETE FROM case_stage_events e WHERE NOT EXISTS (SELECT 1 FROM workflow_cards c WHERE c.id = e.card_id)")
    op.create_foreign_key(
        "case_stage_events_card_id_fkey", "case_stage_events", "workflow_cards", ["card_id"], ["id"], ondelete="CASCADE"
    )
