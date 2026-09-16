"""study_memberships: allow a user to hold more than one role in the same
study (e.g. both annotator and reviewer) by making role part of the
primary key instead of a single mutable column per (study, user).

Revision ID: a4d7e9c1f3b6
Revises: f2a4c6e8b0d1
Create Date: 2026-09-16 14:00:00.000000
"""
from alembic import op

revision = 'a4d7e9c1f3b6'
down_revision = 'f2a4c6e8b0d1'
branch_labels = None
depends_on = None

# study_memberships was renamed from project_memberships by an earlier
# migration (f3a91c7b2e04_rename_project_to_study_and_study_to_); Postgres
# doesn't rename a table's constraints along with it, so the primary key
# is still actually named "project_memberships_pkey" on every real
# deployment -- looked up dynamically here (instead of hardcoding either
# name) so this doesn't assume which one a given database happens to have.
_FIND_PK = "SELECT conname FROM pg_constraint WHERE conrelid = 'study_memberships'::regclass AND contype = 'p'"


def upgrade() -> None:
    # No data to migrate: every existing (study_id, user_id) row keeps its
    # one existing role -- widening the primary key to include "role"
    # doesn't change any existing row's meaning, it just stops forbidding
    # a second row for the same (study_id, user_id) with a different role.
    conn = op.get_bind()
    pk_name = conn.exec_driver_sql(_FIND_PK).scalar()
    conn.exec_driver_sql(f'ALTER TABLE study_memberships DROP CONSTRAINT "{pk_name}"')
    conn.exec_driver_sql("ALTER TABLE study_memberships ADD PRIMARY KEY (study_id, user_id, role)")


def downgrade() -> None:
    # Only safe if no (study_id, user_id) pair actually holds more than
    # one role -- true immediately after upgrade, not guaranteed later.
    conn = op.get_bind()
    pk_name = conn.exec_driver_sql(_FIND_PK).scalar()
    conn.exec_driver_sql(f'ALTER TABLE study_memberships DROP CONSTRAINT "{pk_name}"')
    conn.exec_driver_sql("ALTER TABLE study_memberships ADD PRIMARY KEY (study_id, user_id)")
