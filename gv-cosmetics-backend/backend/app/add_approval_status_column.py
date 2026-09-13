"""
One-off migration script: adds the approval_status column to the users table.

Existing rows (your admin account, and any customers who already signed up)
are backfilled as 'approved' so nobody gets locked out — the pending/rejected
gate only applies to customers who register AFTER this migration runs.

Run this once from inside your backend/app/ folder:

    python add_approval_status_column.py
"""
from sqlalchemy import text
from database import engine  # if this import fails, try: from .database import engine

with engine.connect() as conn:
    conn.execute(text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status VARCHAR DEFAULT 'approved' NOT NULL;"
    ))
    conn.commit()

print("✅ approval_status column added (or already existed). Existing users were backfilled as 'approved'.")