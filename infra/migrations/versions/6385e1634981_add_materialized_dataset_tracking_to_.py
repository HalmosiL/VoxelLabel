"""add materialized dataset tracking to workflow cards

Revision ID: 6385e1634981
Revises: 8b0926a7d51c
Create Date: 2026-08-22 09:25:42.254853
"""
from alembic import op
import sqlalchemy as sa


revision = '6385e1634981'
down_revision = '8b0926a7d51c'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Autogenerate emitted `None` for the FK name (Postgres would pick one
    # implicitly) -- named explicitly so downgrade() can actually reference
    # it; `op.drop_constraint(None, ...)` is not valid.
    op.add_column('workflow_cards', sa.Column('materialized_source_card_id', sa.UUID(), nullable=True))
    op.add_column('workflow_cards', sa.Column('materialized_source_handle', sa.String(length=64), nullable=True))
    op.create_foreign_key(
        'fk_workflow_cards_materialized_source_card_id',
        'workflow_cards', 'workflow_cards',
        ['materialized_source_card_id'], ['id'],
        ondelete='SET NULL',
    )


def downgrade() -> None:
    op.drop_constraint('fk_workflow_cards_materialized_source_card_id', 'workflow_cards', type_='foreignkey')
    op.drop_column('workflow_cards', 'materialized_source_handle')
    op.drop_column('workflow_cards', 'materialized_source_card_id')
