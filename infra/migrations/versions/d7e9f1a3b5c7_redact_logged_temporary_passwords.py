"""notifications: redact temporary passwords already stored in notification_log

Registration-approval mails were logged with the temporary password in
the body (J-08). The mail itself still carries it; the log no longer
does, and this clears the ones already written. Irreversible on purpose.

Revision ID: d7e9f1a3b5c7
Revises: c6d8e0f2a4b6
"""
from alembic import op

revision = "d7e9f1a3b5c7"
down_revision = "c6d8e0f2a4b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        r"""
        UPDATE notification_log
        SET body = regexp_replace(body, '(Temporary password:\s*)\S+', '\1•••••• (not stored)', 'g')
        WHERE body ~ 'Temporary password:\s*\S'
          AND body !~ 'Temporary password:\s*•••••• \(not stored\)'
        """
    )


def downgrade() -> None:
    # The passwords are gone; nothing to restore.
    pass
