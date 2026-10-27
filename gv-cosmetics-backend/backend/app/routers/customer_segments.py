"""
Customer Analysis labels: New customer / Occasional buyer / Loyal customer.

  GET /customer-analysis   (admin) -> every customer's orders, items bought, products, total spent
                                      and their label, plus the rules used

A label is earned by buying MORE, not by a single purchase. It looks at how much a customer has
bought in total (the quantity of items across all their orders) and whether they came back:

    New customer      fewer than 3 items bought so far (including no purchases yet)
    Occasional buyer  3 or more items bought
    Loyal customer    10 or more items bought AND at least 2 separate orders
                      (one big first order is not enough: they have to come back)

Cancelled orders never count. Change the numbers with these Render settings if you like:
    LOYAL_MIN_ITEMS (10)   LOYAL_MIN_ORDERS (2)   OCCASIONAL_MIN_ITEMS (3)

No new table or column is needed: it is worked out from orders and their items.
"""
import os
from typing import Dict, List

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

try:
    from sqlalchemy.orm import selectinload      # loads each order's items in one go (faster)
except ImportError:                              # only in a stripped-down test environment
    selectinload = None

from .. import models, auth
from ..database import get_db

router = APIRouter(prefix="/customer-analysis", tags=["customer-analysis"])

DEFAULTS = {"loyal_min_items": 10, "loyal_min_orders": 2, "occasional_min_items": 3}


def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, ""))
        return value if value >= 1 else default
    except ValueError:
        return default


def thresholds() -> Dict[str, int]:
    th = {
        "loyal_min_items": _env_int("LOYAL_MIN_ITEMS", DEFAULTS["loyal_min_items"]),
        "loyal_min_orders": _env_int("LOYAL_MIN_ORDERS", DEFAULTS["loyal_min_orders"]),
        "occasional_min_items": _env_int("OCCASIONAL_MIN_ITEMS", DEFAULTS["occasional_min_items"]),
    }
    if th["occasional_min_items"] >= th["loyal_min_items"]:       # nonsense settings: use the safe defaults
        return dict(DEFAULTS)
    return th


def segment_for(orders: int, items: int, th: Dict[str, int] = None) -> str:
    th = th or thresholds()
    if items >= th["loyal_min_items"] and orders >= th["loyal_min_orders"]:
        return "Loyal"
    if items >= th["occasional_min_items"]:
        return "Occasional"
    return "New"


def build_customer_stats(users, orders, th: Dict[str, int] = None) -> List[dict]:
    """One row per customer: orders / items / different products / total spent / label."""
    th = th or thresholds()
    stats = {}
    for o in orders:
        if o.status == models.OrderStatus.Cancelled:
            continue
        s = stats.setdefault(o.user_id, {"orders": 0, "items": 0, "products": set(), "total": 0.0})
        s["orders"] += 1
        s["total"] += float(o.total or 0)
        for item in o.items:
            s["items"] += item.quantity or 0
            if item.product_id:
                s["products"].add(item.product_id)
    rows = []
    for u in users:
        s = stats.get(u.id, {"orders": 0, "items": 0, "products": set(), "total": 0.0})
        rows.append({
            "user_id": u.id,
            "email": u.email,
            "name": u.name,
            "orders": s["orders"],
            "items": s["items"],
            "products": len(s["products"]),
            "total": round(s["total"], 2),
            "seg": segment_for(s["orders"], s["items"], th),
        })
    return rows


@router.get("")
def customer_analysis(
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    users = db.query(models.User).filter(models.User.role == models.Role.customer).all()
    query = db.query(models.Order)
    if selectinload is not None:
        query = query.options(selectinload(models.Order.items))
    th = thresholds()
    return {"rules": th, "customers": build_customer_stats(users, query.all(), th)}
