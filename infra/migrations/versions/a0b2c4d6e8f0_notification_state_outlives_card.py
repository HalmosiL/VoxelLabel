"""notifications: job state outlives a deleted card

The board's Undo recreates a deleted card with its original id, but the
notification state row had been cascade-deleted with it, so the job was
announced as new and mailed again (D-12). The row is now kept (no foreign
key); the notification cycle prunes rows of cards gone for a day.

Revision ID: a0b2c4d6e8f0
Revises: f9a1b3c5d7e9
"""
from alembic import op

revision = "a0b2c4d6e8f0"
down_revision = "f9a1b3c5d7e9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("job_notification_state_card_id_fkey", "job_notification_state", type_="foreignkey")


def downgrade() -> None:
    op.execute("DELETE FROM job_notification_state s WHERE NOT EXISTS (SELECT 1 FROM workflow_cards c WHERE c.id = s.card_id)")
    op.create_foreign_key(
        "job_notification_state_card_id_fkey", "job_notification_state", "workflow_cards", ["card_id"], ["id"], ondelete="CASCADE"
    )
