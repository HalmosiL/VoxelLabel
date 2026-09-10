"""add study_versions (point-in-time snapshots of a study's configuration)

Revision ID: b4c7d9e1f2a3
Revises: a3f6d1c8e9b4
Create Date: 2026-09-09 08:00:00.000000
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = 'b4c7d9e1f2a3'
down_revision = 'a3f6d1c8e9b4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'study_versions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('study_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('studies.id', ondelete='CASCADE'), nullable=False),
        sa.Column('number', sa.Integer(), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False, server_default='auto'),
        sa.Column('label', sa.String(length=255), nullable=True),
        sa.Column('created_by', sa.String(length=255), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('snapshot', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('summary', postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default='{}'),
        sa.UniqueConstraint('study_id', 'number', name='uq_study_versions_study_number'),
    )
    op.create_index('ix_study_versions_study_id', 'study_versions', ['study_id'])


def downgrade() -> None:
    op.drop_index('ix_study_versions_study_id', table_name='study_versions')
    op.drop_table('study_versions')
