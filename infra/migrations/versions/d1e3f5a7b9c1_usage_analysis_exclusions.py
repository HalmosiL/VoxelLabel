"""usage: who counts in the analysis; tidy recorded click targets

Adds usage_settings.excluded_user_ids / exclude_admins (accounts that are
recorded but left out of the Usage page's figures), and rewrites click
targets already recorded so that id-like fragments ("Patient 09a1d4c3…")
become "#" -- the same normalisation ingestion now applies, so old and
new rows aggregate together.

Revision ID: d1e3f5a7b9c1
Revises: c9d1e3f5a7b9
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "d1e3f5a7b9c1"
down_revision = "c9d1e3f5a7b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("usage_settings", sa.Column("excluded_user_ids", JSONB(), nullable=False, server_default="[]"))
    op.add_column("usage_settings", sa.Column("exclude_admins", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.execute(
        """
        UPDATE usage_events
        SET detail = jsonb_set(detail, '{target}', to_jsonb(regexp_replace(detail->>'target', '[0-9A-Fa-f]{6,}|[0-9]{4,}', '#', 'g')))
        WHERE event_type = 'click' AND detail ? 'target' AND detail->>'target' ~ '[0-9A-Fa-f]{6,}|[0-9]{4,}'
        """
    )


def downgrade() -> None:
    op.drop_column("usage_settings", "exclude_admins")
    op.drop_column("usage_settings", "excluded_user_ids")
