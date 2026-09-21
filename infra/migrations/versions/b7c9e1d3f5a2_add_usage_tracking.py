"""add usage_events + usage_settings -- how every signed-in person
actually uses admin-ui and the viewer (pages, dwell, actions, clicks,
mouse traces, keys, errors), and the admin-controlled switches that
decide what gets recorded and for how long

Revision ID: b7c9e1d3f5a2
Revises: a4d7e9c1f3b6
Create Date: 2026-09-20 10:00:00.000000
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = 'b7c9e1d3f5a2'
down_revision = 'a4d7e9c1f3b6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'usage_events',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', sa.String(length=255), nullable=False),
        sa.Column('session_id', sa.String(length=64), nullable=False),
        sa.Column('app', sa.String(length=16), nullable=False),
        sa.Column('event_type', sa.String(length=16), nullable=False),
        sa.Column('route', sa.String(length=255), nullable=False),
        sa.Column('name', sa.String(length=64), nullable=True),
        sa.Column('detail', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('duration_ms', sa.Integer(), nullable=True),
        sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )
    op.create_index('ix_usage_events_user_occurred', 'usage_events', ['user_id', 'occurred_at'])
    op.create_index('ix_usage_events_occurred', 'usage_events', ['occurred_at'])
    op.create_index('ix_usage_events_session', 'usage_events', ['session_id'])
    op.create_index('ix_usage_events_type_occurred', 'usage_events', ['event_type', 'occurred_at'])

    op.create_table(
        'usage_settings',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('track_pages', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('track_actions', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('track_clicks', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('track_mouse', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('track_scroll', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('track_keys', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('track_errors', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('mouse_sample_ms', sa.Integer(), nullable=False, server_default='100'),
        sa.Column('retention_days', sa.Integer(), nullable=False, server_default='90'),
        sa.Column('disabled_user_ids', postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default='[]'),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    )


def downgrade() -> None:
    op.drop_table('usage_settings')
    op.drop_index('ix_usage_events_type_occurred', table_name='usage_events')
    op.drop_index('ix_usage_events_session', table_name='usage_events')
    op.drop_index('ix_usage_events_occurred', table_name='usage_events')
    op.drop_index('ix_usage_events_user_occurred', table_name='usage_events')
    op.drop_table('usage_events')
