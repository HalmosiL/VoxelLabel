"""notification_settings.first_observed_at -- marks that the notification
observer's silent first cycle has happened (the empty-state-table check
it replaced swallowed the very first job on a fresh install)

Revision ID: f2a4c6e8b0d1
Revises: e1f4a6c8b3d5
Create Date: 2026-09-12 13:20:00.000000
"""
import sqlalchemy as sa
from alembic import op

revision = 'f2a4c6e8b0d1'
down_revision = 'e1f4a6c8b3d5'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('notification_settings', sa.Column('first_observed_at', sa.DateTime(timezone=True), nullable=True))
    # An installation that has already been observing: treat its state
    # as bootstrapped so this upgrade doesn't add one more silent cycle.
    op.execute("UPDATE notification_settings SET first_observed_at = now() WHERE EXISTS (SELECT 1 FROM job_notification_state)")


def downgrade() -> None:
    op.drop_column('notification_settings', 'first_observed_at')
