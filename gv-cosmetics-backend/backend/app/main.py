import os

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from sqlalchemy import inspect, text

from .database import Base, engine
from .routers import auth, products, orders, addresses, wishlist, notifications, customers, analytics, payments, admin_email

load_dotenv()

Base.metadata.create_all(bind=engine)


def _add_missing_columns():
    """create_all() only creates NEW tables - it never adds columns to a table that
    already exists. This adds the product manufacture/expiry date columns to an
    existing `products` table (safe to run on every start; works on SQLite,
    PostgreSQL and MySQL)."""
    existing = {c["name"] for c in inspect(engine).get_columns("products")}
    with engine.begin() as conn:
        for col in ("manufacture_date", "expiry_date"):
            if col not in existing:
                conn.execute(text(f"ALTER TABLE products ADD COLUMN {col} DATE"))


_add_missing_columns()

app = FastAPI(title="GV Cosmetics API", version="1.0.0")

origins = os.getenv("CORS_ORIGINS", "*")
allow_origins = ["*"] if origins == "*" else [o.strip() for o in origins.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(products.router)
app.include_router(orders.router)
app.include_router(addresses.router)
app.include_router(wishlist.router)
app.include_router(notifications.router)
app.include_router(customers.router)
app.include_router(analytics.router)
app.include_router(payments.router)
app.include_router(admin_email.router)


@app.get("/")
def root():
    return {"status": "ok", "service": "GV Cosmetics API"}


@app.get("/health")
def health():
    return {"status": "healthy"}
