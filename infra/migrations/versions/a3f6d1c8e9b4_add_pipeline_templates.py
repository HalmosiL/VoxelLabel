"""add pipeline templates table

Revision ID: a3f6d1c8e9b4
Revises: e5a17b3c9f42
Create Date: 2026-08-27 10:00:00.000000
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'a3f6d1c8e9b4'
down_revision = 'e5a17b3c9f42'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'pipeline_templates',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('title', sa.String(length=255), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('cards', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('edges', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('created_by', sa.String(length=255), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    op.drop_table('pipeline_templates')
