"""usage: app version on every event; performance and rating switches

Adds usage_events.app_version (which build sent the event -- for
before/after comparisons across releases), usage_settings.track_perf
(browser-measured request timings) and usage_settings.rating_every_n
(how often the viewer asks how demanding a finished case was).

Revision ID: e2f4a6b8c0d2
Revises: d1e3f5a7b9c1
"""
import sqlalchemy as sa
from alembic import op

revision = "e2f4a6b8c0d2"
down_revision = "d1e3f5a7b9c1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("usage_events", sa.Column("app_version", sa.String(40), nullable=True))
    op.add_column("usage_settings", sa.Column("track_perf", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("usage_settings", sa.Column("rating_every_n", sa.Integer(), nullable=False, server_default="3"))


def downgrade() -> None:
    op.drop_column("usage_settings", "rating_every_n")
    op.drop_column("usage_settings", "track_perf")
    op.drop_column("usage_events", "app_version")
