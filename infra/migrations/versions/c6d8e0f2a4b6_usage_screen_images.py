"""usage: case images in screen snapshots (opt-in)

usage_settings.track_screen_images lets screen snapshots carry the case
images as small inline pictures; has_images marks the snapshots that do
(live and archived), so the Usage page offers its show/hide switch only
where there is something to show.

Revision ID: c6d8e0f2a4b6
Revises: b5c7d9e1f3a5
"""
import sqlalchemy as sa
from alembic import op

revision = "c6d8e0f2a4b6"
down_revision = "b5c7d9e1f3a5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("usage_settings", sa.Column("track_screen_images", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("usage_snapshots", sa.Column("has_images", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("usage_snapshots_archive", sa.Column("has_images", sa.Boolean(), nullable=False, server_default="false"))


def downgrade() -> None:
    op.drop_column("usage_snapshots_archive", "has_images")
    op.drop_column("usage_snapshots", "has_images")
    op.drop_column("usage_settings", "track_screen_images")
