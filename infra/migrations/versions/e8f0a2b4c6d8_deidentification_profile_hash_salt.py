"""deidentification: a secret salt per profile for "hash" rules

"hash" was the first 16 hex characters of an unsalted SHA-256, so a
short identifier such as an MRN could be recovered by hashing every
candidate (B-09). Hash rules are now an HMAC with the profile's own
secret. Existing profiles get a fresh random salt, so their hash values
change from now on: a DICOM study imported partly before this migration
and partly after lands on two cases.

Revision ID: e8f0a2b4c6d8
Revises: d7e9f1a3b5c7
"""
import sqlalchemy as sa
from alembic import op

revision = "e8f0a2b4c6d8"
down_revision = "d7e9f1a3b5c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("deidentification_profiles", sa.Column("hash_salt", sa.String(64), nullable=True))
    # gen_random_uuid() draws from the server's strong random source.
    op.execute(
        "UPDATE deidentification_profiles SET hash_salt = "
        "replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')"
    )
    op.alter_column("deidentification_profiles", "hash_salt", nullable=False)


def downgrade() -> None:
    op.drop_column("deidentification_profiles", "hash_salt")
