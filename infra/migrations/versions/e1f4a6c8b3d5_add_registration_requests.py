"""add registration_requests -- self-service "I'd like an account"
submissions from the public registration page, reviewed by an admin

Revision ID: e1f4a6c8b3d5
Revises: d3e5f7a9b2c4
Create Date: 2026-09-12 09:00:00.000000
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = 'e1f4a6c8b3d5'
down_revision = 'd3e5f7a9b2c4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'registration_requests',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('username', sa.String(length=255), nullable=False),
        sa.Column('email', sa.String(length=255), nullable=False),
        sa.Column('first_name', sa.String(length=255), nullable=False),
        sa.Column('last_name', sa.String(length=255), nullable=False),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False, server_default='pending'),
        sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('decided_by', sa.String(length=255), nullable=True),
        sa.Column('rejection_reason', sa.Text(), nullable=True),
    )
    op.create_index('ix_registration_requests_status', 'registration_requests', ['status'])


def downgrade() -> None:
    op.drop_index('ix_registration_requests_status', table_name='registration_requests')
    op.drop_table('registration_requests')
