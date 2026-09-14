"""
One-off migration script: adds the email verification columns to the users
table.

Existing users (your admin account, and anyone who already signed up) are
backfilled as email_verified = TRUE, so nobody gets locked out — the
verification requirement only applies to customers who register AFTER this
migration runs.

Run this once from inside your backend/app/ folder:

    python add_email_verification_columns.py
"""
from sqlalchemy import text
from database import engine  # if this import fails, try: from .database import engine

with engine.connect() as conn:
    conn.execute(text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT true NOT NULL;"
    ))
    conn.execute(text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code VARCHAR;"
    ))
    conn.execute(text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code_expires TIMESTAMP;"
    ))
    conn.commit()

print("✅ Email verification columns added (or already existed). Existing users were backfilled as verified.")
