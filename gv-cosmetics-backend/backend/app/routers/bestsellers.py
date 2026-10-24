"""
Best Sellers: the Top 10 products, worked out automatically from real sales and real reviews.

  GET /bestsellers          -> the ranking for customers (rank, average stars; no sales numbers)
  GET /bestsellers/admin    -> the same ranking with units sold and the score (admin only)

How the ranking works (nothing to set by hand):
  * Units sold in the last BESTSELLER_DAYS days (default 30) from orders that were not cancelled.
  * The average star rating from customers' reviews. A product with only a review or two is not
    treated as a perfect 5.0: its average is pulled toward the shop-wide average until it has a few
    reviews, so a single review counts for much less than many. Unreviewed products count as average.
  * score = 70% sales (compared with the best seller) + 30% rating (out of 5).
  * Only products that actually sold in that period qualify, and expired products are left out.
  * Ties go to more units sold, then the higher rating, then the older product.
The result is remembered for 60 seconds, so it follows new orders and reviews within a minute.

No new table or column is needed: it is calculated from orders, order items and ratings.
"""
import os
import time
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

try:
    from sqlalchemy.orm import selectinload      # loads each order's items in one go (faster)
except ImportError:                              # only in a stripped-down test environment
    selectinload = None

from .. import models, auth
from ..database import get_db

router = APIRouter(prefix="/bestsellers", tags=["bestsellers"])

TOP_N = 10
WEIGHT_SALES = 0.7
WEIGHT_RATING = 0.3
PRIOR_REVIEWS = 3            # how many "average" reviews every product starts with
DEFAULT_PRIOR_RATING = 3.5   # used only when nobody has reviewed anything yet
CACHE_SECONDS = 60
PH_TZ = timezone(timedelta(hours=8))     # Philippines: UTC+8, no daylight saving


def window_days() -> int:
    try:
        return min(365, max(1, int(os.getenv("BESTSELLER_DAYS", "30"))))
    except ValueError:
        return 30


def rank_best_sellers(products, units: Dict[int, int], rating_totals: Dict[int, list], today: date, top_n: int = TOP_N) -> List[dict]:
    """The ranking itself (no database): products that sold, not expired, best score first.
    units: product id -> units sold in the period; rating_totals: product id -> [sum of stars, count]."""
    total_stars = sum(t[0] for t in rating_totals.values())
    total_count = sum(t[1] for t in rating_totals.values())
    shop_avg = (total_stars / total_count) if total_count else DEFAULT_PRIOR_RATING

    eligible = []
    for p in products:
        sold = units.get(p.id, 0)
        if sold <= 0:
            continue                                   # a best seller must actually sell
        if p.expiry_date and p.expiry_date < today:
            continue                                   # expired products can't be bought
        stars, count = rating_totals.get(p.id, (0, 0))
        raw_avg = (stars / count) if count else 0.0
        smoothed = (count * raw_avg + PRIOR_REVIEWS * shop_avg) / (count + PRIOR_REVIEWS)
        eligible.append((p, sold, raw_avg, count, smoothed))
    if not eligible:
        return []

    top_units = max(e[1] for e in eligible)
    rows = []
    for p, sold, raw_avg, count, smoothed in eligible:
        score = WEIGHT_SALES * (sold / top_units) + WEIGHT_RATING * (smoothed / 5.0)
        rows.append({
            "product_id": p.id, "name": p.name, "units": sold,
            "avg_rating": round(raw_avg, 2), "rating_count": count,
            "rating_score": round(smoothed, 3), "score": round(score, 4),
        })
    rows.sort(key=lambda r: (-r["score"], -r["units"], -r["rating_score"], r["product_id"]))
    rows = rows[:top_n]
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
    return rows


_cache = {"at": 0.0, "data": None}


def compute_best_sellers(db: Session, force: bool = False) -> dict:
    now_t = time.time()
    if not force and _cache["data"] is not None and now_t - _cache["at"] < CACHE_SECONDS:
        return _cache["data"]

    days = window_days()
    cutoff = datetime.utcnow() - timedelta(days=days)
    today = datetime.now(PH_TZ).date()

    query = db.query(models.Order).filter(models.Order.created_at >= cutoff)
    if selectinload is not None:
        query = query.options(selectinload(models.Order.items))
    units: Dict[int, int] = {}
    for order in query.all():
        if order.status == models.OrderStatus.Cancelled:
            continue
        for item in order.items:
            if item.product_id:
                units[item.product_id] = units.get(item.product_id, 0) + (item.quantity or 0)

    rating_totals: Dict[int, list] = {}
    for r in db.query(models.Rating).all():
        t = rating_totals.setdefault(r.product_id, [0, 0])
        t[0] += r.stars
        t[1] += 1

    data = {
        "updated_at": datetime.utcnow().isoformat(),
        "window_days": days,
        "items": rank_best_sellers(db.query(models.Product).all(), units, rating_totals, today),
    }
    _cache["at"], _cache["data"] = now_t, data
    return data


@router.get("")
def best_sellers(
    db: Session = Depends(get_db),
    user: models.User = Depends(auth.get_current_user),
):
    """For customers: which products are the best sellers right now, and their rank."""
    data = compute_best_sellers(db)
    return {
        "updated_at": data["updated_at"],
        "window_days": data["window_days"],
        "items": [
            {"product_id": i["product_id"], "rank": i["rank"], "avg_rating": i["avg_rating"], "rating_count": i["rating_count"]}
            for i in data["items"]
        ],
    }


@router.get("/admin")
def best_sellers_admin(
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    """For the admin: the same ranking with units sold and the score behind it."""
    data = compute_best_sellers(db)
    return {
        **data,
        "top_n": TOP_N,
        "weights": {"sales": WEIGHT_SALES, "rating": WEIGHT_RATING},
    }
