"""
Delivery tracking: a live map of orders that are out for delivery today.

  Admin
    GET    /delivery/board                  -> today's deliveries + riders (for the Deliveries map)
    POST   /delivery/riders                 -> add a rider (returns the rider's private link token)
    DELETE /delivery/riders/{id}            -> remove a rider (their old link stops working)
    PATCH  /delivery/orders/{order_id}      -> assign a rider, mark Rush, or pin the address by hand
  Rider (no login: the secret token in the rider's own link identifies them)
    POST   /delivery/rider-ping             -> the rider's phone sends its GPS position
    POST   /delivery/rider-orders           -> the orders this rider is carrying (for the rider's map)
    POST   /delivery/rider-delivered        -> the rider marks an order Delivered
  Customer
    GET    /delivery/track/{order_id}       -> where the rider is, only while THEIR order is For Delivery

Automatic assignment
  A rider is "available" while their phone is sharing its location (a position in the last
  5 minutes) and they carry fewer than RIDER_MAX_ORDERS orders (default 5). Whenever an order
  becomes For Delivery, a rider comes online, or a delivery is completed, waiting orders are
  handed out automatically: Rush first, then oldest first, each to the available rider with the
  fewest orders (nearest on a tie). The customer is notified with the rider's name and phone.
  The admin can still change a rider by hand on the Deliveries screen.

Emails (sent in the background, see notify.py)
  * the customer: "your order is on its way" with the rider's name and phone;
  * the rider, if an email was saved for them: their personal page link and the orders
    they were just given. The rider's page also shows each customer's mobile number.

How it works
  * The rider opens their personal link (frontend/rider.html?t=TOKEN) on a phone and taps
    "Start sharing". The phone sends its position every few seconds.
  * Delivery addresses are turned into map points with OpenStreetMap's free Nominatim
    geocoder when an order becomes "For Delivery" (in a background thread, at most one
    request per second as its usage policy asks). If an address can't be found, the admin
    can click the map to pin it.
  * A customer only ever sees the rider's position while their own order is "For Delivery"
    (status Shipped) - never before and never after.

Adds a `riders` table and five columns on `orders`; app/main.py creates them on startup.
"""
import json
import os
import re
import secrets
import threading
import time
import urllib.parse
import urllib.request
import math
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import models, auth, notify
from ..database import get_db, SessionLocal

router = APIRouter(prefix="/delivery", tags=["delivery"])

PH_TZ = timezone(timedelta(hours=8))     # Philippines: UTC+8, no daylight saving
FRESH_SECONDS = 300                      # a rider position newer than 5 minutes counts as "live"
# A loose box around the Philippines, to catch typos and bad GPS values
LAT_MIN, LAT_MAX, LNG_MIN, LNG_MAX = 4.0, 22.0, 116.0, 128.0


class RiderIn(BaseModel):
    name: str
    phone: Optional[str] = None
    email: Optional[str] = None


class RiderUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None


class SiteUrlIn(BaseModel):
    url: str


class RiderToken(BaseModel):
    token: str


class RiderDelivered(BaseModel):
    token: str
    order_id: int


class RiderPing(BaseModel):
    token: str
    lat: float
    lng: float


class OrderDeliveryPatch(BaseModel):
    rider_id: Optional[int] = None
    clear_rider: bool = False
    is_rush: Optional[bool] = None
    lat: Optional[float] = None
    lng: Optional[float] = None


def valid_point(lat, lng) -> bool:
    return (
        lat is not None and lng is not None
        and LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX
    )


def _iso(dt) -> Optional[str]:
    return dt.isoformat() if dt else None


def _is_fresh(rider, now: datetime) -> bool:
    return bool(rider.updated_at) and (now - rider.updated_at).total_seconds() <= FRESH_SECONDS


def _rider_public(rider, now: datetime) -> dict:
    return {
        "name": rider.name,
        "phone": rider.phone,
        "lat": rider.lat,
        "lng": rider.lng,
        "updated_at": _iso(rider.updated_at),
        "fresh": _is_fresh(rider, now),
    }


def clean_phone(value):
    """Returns a tidy phone number, None if empty; raises 400 if it doesn't look like one."""
    phone = (value or "").strip()
    if not phone:
        return None
    if not re.fullmatch(r"[0-9+()\-\s]{7,20}", phone):
        raise HTTPException(400, "Enter a valid phone number (digits, +, - or spaces).")
    return phone


def clean_email(value):
    """A tidy email address, None if empty; raises 400 if it doesn't look like one."""
    email = (value or "").strip().lower()
    if not email:
        return None
    if len(email) > 120 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(400, "Enter a valid email address.")
    return email


def _customer_phone(order):
    """The customer's mobile number for the rider: the one typed at checkout, otherwise the phone on
    their default (or first) saved address, so older orders still have a number."""
    if getattr(order, "shipping_phone", None):
        return order.shipping_phone
    user = getattr(order, "user", None)
    addresses = list(getattr(user, "addresses", None) or [])
    for a in addresses:
        if getattr(a, "is_default", False) and a.phone:
            return a.phone
    return next((a.phone for a in addresses if a.phone), None)


def haversine_km(lat1, lng1, lat2, lng2) -> float:
    rad = math.radians
    h = math.sin(rad(lat2 - lat1) / 2) ** 2 + math.cos(rad(lat1)) * math.cos(rad(lat2)) * math.sin(rad(lng2 - lng1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def _max_orders_per_rider() -> int:
    try:
        return max(1, int(os.getenv("RIDER_MAX_ORDERS", "5")))
    except ValueError:
        return 5


def _assign_notice(db, order, rider) -> None:
    """The in-app (bell) notice to the customer that a rider has their order."""
    phone = f" You can reach them at {rider.phone}." if rider.phone else ""
    db.add(models.Notification(
        user_id=order.user_id,
        title="Rider on the way",
        message=f"Your order {order.order_number} is with rider {rider.name}.{phone} Track them from My Orders.",
        type="shipped",
    ))


def _send_assignment_emails(db, pairs) -> None:
    """After orders were given to riders: email each customer, and email each rider (once, with
    all the orders they just got) their personal page link."""
    if not pairs:
        return
    site = notify.site_url(db)
    by_rider = {}
    for order, rider in pairs:
        notify.email_customer(order, "rider", rider=rider, site=site)
        by_rider.setdefault(rider.id, (rider, []))[1].append(order)
    for rider, orders in by_rider.values():
        link = f"{site}/rider.html?t={rider.token}" if site else ""
        if rider.email and not link:
            print(f"[notify] cannot add the rider page link for {rider.name}: the website address is unknown "
                  f"(set SITE_URL on Render, or open the Deliveries screen once)")
        notify.email_rider(rider, orders, link)


def auto_assign_orders(db, assigned_out=None) -> int:
    """Hands out waiting For Delivery orders to available riders. Returns how many were assigned.
    The caller commits. (order, rider) pairs are appended to assigned_out, for the emails."""
    now = datetime.utcnow()
    live = [r for r in db.query(models.Rider).all() if _is_fresh(r, now)]
    if not live:
        return 0
    out = db.query(models.Order).filter(models.Order.status == models.OrderStatus.Shipped).all()
    waiting = [o for o in out if o.rider_id is None]
    if not waiting:
        return 0
    load = {r.id: sum(1 for o in out if o.rider_id == r.id) for r in live}
    cap = _max_orders_per_rider()
    waiting.sort(key=lambda o: (not o.is_rush, o.id))          # Rush first, then oldest

    assigned = 0
    for order in waiting:
        candidates = [r for r in live if load[r.id] < cap]
        if not candidates:
            break                                              # everyone is full: wait for a delivery to finish

        def score(r):
            near = 0.0
            if order.dest_lat is not None and r.lat is not None:
                near = haversine_km(r.lat, r.lng, order.dest_lat, order.dest_lng)
            return (load[r.id], near, r.id)

        rider = min(candidates, key=score)
        order.rider_id = rider.id
        load[rider.id] += 1
        assigned += 1
        _assign_notice(db, order, rider)
        if assigned_out is not None:
            assigned_out.append((order, rider))
    return assigned


def run_auto_assign(db) -> int:
    """auto_assign_orders + commit + emails, and never lets a problem here break the caller."""
    try:
        pairs = []
        n = auto_assign_orders(db, pairs)
        if n:
            db.commit()
            _send_assignment_emails(db, pairs)
        return n
    except Exception as e:
        print(f"[delivery] automatic assignment failed: {e}")
        try:
            db.rollback()
        except Exception:
            pass
        return 0


# ───────────── turning an address into a map point ─────────────
def build_queries(address: str):
    """Search texts to try, most specific first: full address, then from the barangay,
    then just city + province. 'Brgy. Bulua' becomes 'Bulua' (numbered ones stay 'Barangay 12')."""
    parts = [p.strip() for p in (address or "").split(",") if p.strip()]
    cleaned = [re.sub(r"^(brgy\.?|barangay)\s+(?=\D)", "", p, flags=re.I) for p in parts]
    candidates = []
    if cleaned:
        candidates.append(", ".join(cleaned))
    if len(cleaned) > 2:
        candidates.append(", ".join(cleaned[1:]))
    if len(cleaned) >= 2:
        candidates.append(", ".join(cleaned[-2:]))
    queries = []
    for c in candidates:
        q = c + ", Philippines"
        if q not in queries:
            queries.append(q)
    return queries


def _nominatim(query: str):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": query, "format": "json", "limit": 1, "countrycodes": "ph"}
    )
    req = urllib.request.Request(
        url, headers={"User-Agent": os.getenv("GEOCODER_USER_AGENT", "GVCosmeticsDeliveryTracker/1.0")}
    )
    with urllib.request.urlopen(req, timeout=6) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data:
        return float(data[0]["lat"]), float(data[0]["lon"])
    return None


def geocode_address(address: str):
    for i, query in enumerate(build_queries(address)):
        if i:
            time.sleep(1.1)          # Nominatim allows at most one request per second
        try:
            point = _nominatim(query)
        except Exception as e:
            print(f"[delivery] geocoding '{query}' failed: {e}")
            point = None
        if point and valid_point(*point):
            return point
    return None


_geocoding = set()
_geocoding_lock = threading.Lock()


def _geocode_order_in_background(order_id: int) -> None:
    db = SessionLocal()
    try:
        order = db.query(models.Order).filter(models.Order.id == order_id).first()
        if order and order.dest_lat is None:
            point = geocode_address(order.shipping_address)
            if point:
                order.dest_lat, order.dest_lng = point
                db.commit()
    except Exception as e:
        print(f"[delivery] could not locate order {order_id}: {e}")
        try:
            db.rollback()
        except Exception:
            pass
    finally:
        db.close()
        with _geocoding_lock:
            _geocoding.discard(order_id)


def schedule_geocode(order_id: int) -> None:
    """Looks up an order's address in the background (never blocks a request)."""
    with _geocoding_lock:
        if order_id in _geocoding:
            return
        _geocoding.add(order_id)
    threading.Thread(target=_geocode_order_in_background, args=(order_id,), daemon=True, name="geocode").start()


# ───────────── admin ─────────────
def _order_row(o) -> dict:
    return {
        "id": o.id,
        "order_number": o.order_number,
        "customer": o.customer_name,
        "address": o.shipping_address,
        "status": o.status.value if hasattr(o.status, "value") else str(o.status),
        "is_rush": bool(o.is_rush),
        "rider_id": o.rider_id,
        "lat": o.dest_lat,
        "lng": o.dest_lng,
        "delivered_at": _iso(o.delivered_at),
    }


@router.get("/board")
def delivery_board(
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    now = datetime.utcnow()
    start_today_utc = (
        datetime.now(PH_TZ).replace(hour=0, minute=0, second=0, microsecond=0)
        .astimezone(timezone.utc).replace(tzinfo=None)
    )
    out_for_delivery = db.query(models.Order).filter(models.Order.status == models.OrderStatus.Shipped).all()
    delivered_today = db.query(models.Order).filter(
        models.Order.status == models.OrderStatus.Delivered,
        models.Order.delivered_at >= start_today_utc,
    ).all()

    # Orders set to For Delivery before tracking existed: find their address now (max 5 at a time)
    for o in [o for o in out_for_delivery if o.dest_lat is None][:5]:
        schedule_geocode(o.id)

    riders = db.query(models.Rider).all()
    return {
        "orders": [_order_row(o) for o in out_for_delivery + delivered_today],
        "riders": [
            {"id": r.id, "token": r.token, "email": r.email, **_rider_public(r, now)}
            for r in riders
        ],
    }


@router.post("/riders")
def add_rider(
    payload: RiderIn,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    name = (payload.name or "").strip()
    if not name or len(name) > 40:
        raise HTTPException(400, "Enter the rider's name (up to 40 characters).")
    rider = models.Rider(name=name, phone=clean_phone(payload.phone), email=clean_email(payload.email),
                         token=secrets.token_urlsafe(16))
    db.add(rider)
    db.commit()
    db.refresh(rider)
    return {"id": rider.id, "token": rider.token, "email": rider.email, **_rider_public(rider, datetime.utcnow())}


@router.patch("/riders/{rider_id}")
def update_rider(
    rider_id: int,
    payload: RiderUpdate,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    rider = db.query(models.Rider).filter(models.Rider.id == rider_id).first()
    if not rider:
        raise HTTPException(404, "Rider not found")
    if payload.name is not None:
        name = payload.name.strip()
        if not name or len(name) > 40:
            raise HTTPException(400, "Enter the rider's name (up to 40 characters).")
        rider.name = name
    if payload.phone is not None:
        rider.phone = clean_phone(payload.phone)       # an empty value clears it
    if payload.email is not None:
        rider.email = clean_email(payload.email)       # an empty value clears it
    db.commit()
    return {"id": rider.id, "email": rider.email, **_rider_public(rider, datetime.utcnow())}


@router.delete("/riders/{rider_id}")
def remove_rider(
    rider_id: int,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    rider = db.query(models.Rider).filter(models.Rider.id == rider_id).first()
    if not rider:
        raise HTTPException(404, "Rider not found")
    for o in db.query(models.Order).filter(models.Order.rider_id == rider_id).all():
        o.rider_id = None
    db.delete(rider)
    db.commit()
    return {"detail": "Rider removed"}


@router.patch("/orders/{order_id}")
def update_order_delivery(
    order_id: int,
    payload: OrderDeliveryPatch,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(404, "Order not found")
    assigned_pair = None

    if payload.clear_rider:
        order.rider_id = None
    elif payload.rider_id is not None:
        if order.status != models.OrderStatus.Shipped:
            raise HTTPException(400, "Only orders that are For Delivery can be given to a rider.")
        rider = db.query(models.Rider).filter(models.Rider.id == payload.rider_id).first()
        if not rider:
            raise HTTPException(404, "Rider not found")
        newly_assigned = order.rider_id != rider.id
        order.rider_id = rider.id
        if newly_assigned:
            _assign_notice(db, order, rider)
            assigned_pair = (order, rider)

    if payload.is_rush is not None:
        order.is_rush = payload.is_rush

    if payload.lat is not None or payload.lng is not None:
        if not valid_point(payload.lat, payload.lng):
            raise HTTPException(400, "That location is outside the Philippines. Please pin it again.")
        order.dest_lat, order.dest_lng = payload.lat, payload.lng

    db.commit()
    if assigned_pair:
        _send_assignment_emails(db, [assigned_pair])     # the customer and the rider are told
    return _order_row(order)


@router.put("/site-url")
def save_site_url(
    payload: SiteUrlIn,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    """The admin's browser tells the server the website's address (used for the rider's page link
    in emails). Called automatically when the Deliveries screen opens."""
    url = (payload.url or "").strip().rstrip("/")
    if not re.fullmatch(r"https?://[^\s/]+(/[^\s]*)?", url) or len(url) > 200:
        raise HTTPException(400, "That is not a valid website address.")
    notify.save_site_url(db, url)
    db.commit()
    return {"url": url}


# ───────────── rider ─────────────
@router.post("/rider-ping")
def rider_ping(payload: RiderPing, db: Session = Depends(get_db)):
    rider = db.query(models.Rider).filter(models.Rider.token == payload.token).first()
    if not rider:
        raise HTTPException(404, "This rider link is not valid any more. Ask the admin for a new one.")
    if not valid_point(payload.lat, payload.lng):
        raise HTTPException(400, "Location looks wrong")
    rider.lat, rider.lng = payload.lat, payload.lng
    rider.updated_at = datetime.utcnow()
    db.commit()
    # This rider is online, so any orders still waiting for a rider can go to them
    assigned = run_auto_assign(db)
    return {"ok": True, "name": rider.name, "assigned": assigned}


def _rider_by_token(db: Session, token: str):
    rider = db.query(models.Rider).filter(models.Rider.token == token).first()
    if not rider:
        raise HTTPException(404, "This rider link is not valid any more. Ask the admin for a new one.")
    return rider


@router.post("/rider-orders")
def rider_orders(payload: RiderToken, db: Session = Depends(get_db)):
    """The orders this rider is carrying right now, for the map on the rider's page."""
    rider = _rider_by_token(db, payload.token)
    mine = [
        o for o in db.query(models.Order).filter(models.Order.status == models.OrderStatus.Shipped).all()
        if o.rider_id == rider.id
    ]
    for o in [o for o in mine if o.dest_lat is None][:5]:
        schedule_geocode(o.id)
    return {
        "rider": {"name": rider.name, "phone": rider.phone},
        "orders": [
            {
                "id": o.id,
                "order_number": o.order_number,
                "customer": o.shipping_name or o.customer_name,
                "address": o.shipping_address,
                "lat": o.dest_lat,
                "lng": o.dest_lng,
                "is_rush": bool(o.is_rush),
                "total": o.total,
                "payment_method": o.payment_method,
                "payment_status": o.payment_status,
                "phone": _customer_phone(o),
                "items": [{"name": i.product_name, "qty": i.quantity} for i in o.items],
            }
            for o in mine
        ],
    }


@router.post("/rider-delivered")
def rider_delivered(payload: RiderDelivered, db: Session = Depends(get_db)):
    """The rider marks an order as delivered. It becomes Delivered for the admin and the
    customer straight away (status, time, and a notification to the customer)."""
    rider = _rider_by_token(db, payload.token)
    order = db.query(models.Order).filter(models.Order.id == payload.order_id).first()
    if not order or order.rider_id != rider.id:
        raise HTTPException(404, "That order is not on your list.")
    if order.status != models.OrderStatus.Shipped:
        raise HTTPException(400, "This order is not out for delivery.")

    order.status = models.OrderStatus.Delivered
    order.delivered_at = datetime.utcnow()
    if order.payment_method == "cod":
        order.payment_status = "paid"        # cash was handed over at the door
    db.add(models.Notification(
        user_id=order.user_id,
        title="Order Delivered",
        message=f"Your order {order.order_number} has been delivered. Thank you for shopping with GV Cosmetics!",
        type="delivered",
    ))
    db.commit()
    notify.email_customer(order, "delivered", site=notify.site_url(db))
    run_auto_assign(db)                      # this rider has room again: hand out any waiting orders
    return {"ok": True, "order_number": order.order_number}


# ───────────── customer ─────────────
@router.get("/track/{order_id}")
def track_order(
    order_id: int,
    db: Session = Depends(get_db),
    user: models.User = Depends(auth.get_current_user),
):
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(404, "Order not found")
    if user.role != models.Role.admin and order.user_id != user.id:
        raise HTTPException(403, "Not authorized to track this order")

    now = datetime.utcnow()
    result = {
        "active": order.status == models.OrderStatus.Shipped,
        "order_number": order.order_number,
        "status": order.status.value,
        "dest": None,
        "rider": None,
    }
    if not result["active"]:
        return result            # not out for delivery: no location is shared

    if order.dest_lat is not None:
        result["dest"] = {"lat": order.dest_lat, "lng": order.dest_lng}
    else:
        schedule_geocode(order.id)
    if order.rider_id:
        rider = db.query(models.Rider).filter(models.Rider.id == order.rider_id).first()
        if rider and rider.lat is not None:
            result["rider"] = _rider_public(rider, now)
        elif rider:
            result["rider"] = {"name": rider.name, "lat": None, "lng": None, "updated_at": None, "fresh": False}
    return result
