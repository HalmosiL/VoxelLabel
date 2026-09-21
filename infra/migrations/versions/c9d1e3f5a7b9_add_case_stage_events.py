"""add case_stage_events -- when a case became available in an
Annotation/Review card's queue, the one fact output_case_ids (a plain
JSONB list overwritten on every Run) can't answer on its own; backfills
one row per currently-queued case, stamped with its card's own
created_at as a best-known lower bound, so pipeline-health reporting
doesn't start with every pending case looking brand new

Revision ID: c9d1e3f5a7b9
Revises: b7c9e1d3f5a2
Create Date: 2026-09-21 09:00:00.000000
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = 'c9d1e3f5a7b9'
down_revision = 'b7c9e1d3f5a2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'case_stage_events',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('study_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('card_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('workflow_cards.id', ondelete='CASCADE'), nullable=False),
        sa.Column('case_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('cases.id', ondelete='CASCADE'), nullable=False),
        sa.Column('occurred_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.UniqueConstraint('card_id', 'case_id', name='uq_case_stage_events_card_case'),
    )
    op.create_index('ix_case_stage_events_study_occurred', 'case_stage_events', ['study_id', 'occurred_at'])
    op.create_index('ix_case_stage_events_card_case', 'case_stage_events', ['card_id', 'case_id'])

    # Every case already sitting in an Annotation/Review card's scope --
    # queue-start unknown, so its own card's created_at is the best
    # available lower bound. engine.py takes over with exact timestamps
    # for everything from here on (a case only ever gets backfilled
    # once: the (card_id, case_id) unique constraint means a real Run
    # afterwards is a no-op for any case already covered here).
    op.execute(
        """
        INSERT INTO case_stage_events (id, study_id, card_id, case_id, occurred_at)
        SELECT gen_random_uuid(), wc.study_id, wc.id, (elem)::uuid, wc.created_at
        FROM workflow_cards wc, jsonb_array_elements_text(wc.output_case_ids) AS elem
        WHERE wc.type IN ('ANNOTATION', 'REVIEW')
          AND jsonb_typeof(wc.output_case_ids) = 'array'
        ON CONFLICT (card_id, case_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index('ix_case_stage_events_card_case', table_name='case_stage_events')
    op.drop_index('ix_case_stage_events_study_occurred', table_name='case_stage_events')
    op.drop_table('case_stage_events')
