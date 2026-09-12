"""drop notification_preferences.notify_case_change -- only job-level
changes (assignment, status) are emailed now, never individual cases

Revision ID: d3e5f7a9b2c4
Revises: c8d2e4f6a1b7
Create Date: 2026-09-11 15:30:00.000000
"""
import sqlalchemy as sa
from alembic import op

revision = 'd3e5f7a9b2c4'
down_revision = 'c8d2e4f6a1b7'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column('notification_preferences', 'notify_case_change')


def downgrade() -> None:
    op.add_column('notification_preferences', sa.Column('notify_case_change', sa.Boolean(), nullable=False, server_default=sa.true()))
