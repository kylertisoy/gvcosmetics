"""
One-off migration script: adds the cancel_reason column to the orders table.

Run this once from inside your backend/app/ folder:

    python add_cancel_reason_column.py
"""
from sqlalchemy import text
from database import engine  # if this import fails, try: from .database import engine

with engine.connect() as conn:
    conn.execute(text(
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR;"
    ))
    conn.commit()

print("✅ cancel_reason column added (or already existed).")
