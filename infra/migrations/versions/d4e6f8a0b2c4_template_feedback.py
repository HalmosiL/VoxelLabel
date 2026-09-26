"""pipeline templates: connections from cards their makers create

A template saved from a board stored the cards a Split/Review creates when
it runs (Lane A, "... (rejected)") as ordinary cards, so inserting it made
fresh ones and left the copies wired to the jobs (K5). Such connections are
now kept separately, as `feedback`.

Revision ID: d4e6f8a0b2c4
Revises: c2d4e6f8a0b2
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "d4e6f8a0b2c4"
down_revision = "c2d4e6f8a0b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("pipeline_templates", sa.Column("feedback", JSONB(), nullable=False, server_default="[]"))


def downgrade() -> None:
    op.drop_column("pipeline_templates", "feedback")
