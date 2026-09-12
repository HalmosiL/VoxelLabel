"""add the notification service's tables (settings, per-user preferences,
per-job observed state, delivery log)

Revision ID: c8d2e4f6a1b7
Revises: b4c7d9e1f2a3
Create Date: 2026-09-11 14:00:00.000000
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = 'c8d2e4f6a1b7'
down_revision = 'b4c7d9e1f2a3'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'notification_settings',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('smtp_host', sa.String(length=255), nullable=False, server_default='mailpit'),
        sa.Column('smtp_port', sa.Integer(), nullable=False, server_default='1025'),
        sa.Column('smtp_username', sa.String(length=255), nullable=True),
        sa.Column('smtp_password', sa.String(length=255), nullable=True),
        sa.Column('smtp_use_tls', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('smtp_use_ssl', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('from_address', sa.String(length=255), nullable=False, server_default='VoxelLabel <no-reply@voxellabel.local>'),
        sa.Column('platform_base_url', sa.String(length=512), nullable=False, server_default='http://localhost:5173'),
        sa.Column('poll_interval_seconds', sa.Integer(), nullable=False, server_default='60'),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    op.create_table(
        'notification_preferences',
        sa.Column('user_id', sa.String(length=255), primary_key=True),
        sa.Column('email_enabled', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('notify_new_job', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('notify_status_change', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('notify_case_change', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    op.create_table(
        'job_notification_state',
        sa.Column('card_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('workflow_cards.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('assigned_user_id', sa.String(length=255), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('case_states', postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default='{}'),
        sa.Column('observed_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    op.create_table(
        'notification_log',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('user_id', sa.String(length=255), nullable=False),
        sa.Column('email', sa.String(length=255), nullable=True),
        sa.Column('event_type', sa.String(length=32), nullable=False),
        sa.Column('card_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('subject', sa.String(length=255), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('error', sa.Text(), nullable=True),
    )
    op.create_index('ix_notification_log_created_at', 'notification_log', ['created_at'])
    op.create_index('ix_notification_log_user_id', 'notification_log', ['user_id'])


def downgrade() -> None:
    op.drop_index('ix_notification_log_user_id', table_name='notification_log')
    op.drop_index('ix_notification_log_created_at', table_name='notification_log')
    op.drop_table('notification_log')
    op.drop_table('job_notification_state')
    op.drop_table('notification_preferences')
    op.drop_table('notification_settings')
