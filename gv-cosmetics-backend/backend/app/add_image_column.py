"""
One-off migration script: adds the image_url column to the products table.
Run this once from inside your backend/app/ folder:

    python add_image_column.py

It reuses your existing database engine (from database.py), so no need to
paste your connection string here.
"""
from sqlalchemy import text
from database import engine  # if this import fails, try: from .database import engine

with engine.connect() as conn:
    conn.execute(text("ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;"))
    conn.commit()

print("✅ image_url column added (or already existed).")
