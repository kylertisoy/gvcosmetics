import json
import random
import string
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas, auth
from ..database import get_db
from .delivery import schedule_geocode

router = APIRouter(prefix="/orders", tags=["orders"])

VALID_PAYMENT_METHODS = {"cod", "gcash", "card", "maya"}


# Philippines is UTC+8 all year (no daylight saving), so a fixed offset is enough
# and needs no timezone database on the server.
PH_TZ = timezone(timedelta(hours=8))


def _today_ph() -> date:
    return datetime.now(PH_TZ).date()


def _effective_price(product) -> float:
    """The price actually charged: the sale price when the admin has set one that is
    lower than the regular price, otherwise the regular price. The shop page uses the
    same rule, so the price a customer sees is the price they pay."""
    sale = getattr(product, "sale_price", None)
    if sale and 0 < sale < product.price:
        return float(sale)
    return float(product.price)


# What customers read in notifications (the stored status value stays "Shipped")
STATUS_LABELS = {"Shipped": "For Delivery"}


def _gen_order_number(db: Session) -> str:
    count = db.query(models.Order).count()
    return f"ORD-{100 + count:03d}"


def _gen_tracking() -> str:
    return "TRK-" + "".join(random.choices(string.ascii_uppercase + string.digits, k=8))


@router.post("", response_model=schemas.OrderOut)
def create_order(
    payload: schemas.OrderCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    if not payload.items:
        raise HTTPException(status_code=400, detail="Cart is empty")

    payment_method = getattr(payload, "payment_method", "cod") or "cod"
    if payment_method not in VALID_PAYMENT_METHODS:
        raise HTTPException(status_code=400, detail=f"payment_method must be one of {sorted(VALID_PAYMENT_METHODS)}")

    today = _today_ph()
    total = 0.0
    order_items = []
    for item in payload.items:
        product = db.query(models.Product).filter(models.Product.id == item.product_id).first()
        if not product:
            raise HTTPException(status_code=404, detail=f"Product {item.product_id} not found")
        if item.quantity < 1:
            raise HTTPException(status_code=400, detail="Quantity must be at least 1")
        # A product is expired from the day AFTER its expiry date. Blocked here on the
        # server so it can't be bypassed by editing the page or calling the API directly.
        if product.expiry_date and product.expiry_date < today:
            raise HTTPException(
                status_code=400,
                detail=f"{product.name} has expired and can no longer be ordered",
            )
        if product.stock < item.quantity:
            raise HTTPException(status_code=400, detail=f"Not enough stock for {product.name}")

        unit_price = _effective_price(product)
        subtotal = unit_price * item.quantity
        total += subtotal
        product.stock -= item.quantity
        order_items.append(
            models.OrderItem(
                product_id=product.id,
                product_name=product.name,
                unit_price=unit_price,
                quantity=item.quantity,
            )
        )

    order = models.Order(
        order_number=_gen_order_number(db),
        user_id=current_user.id,
        total=total,
        status=models.OrderStatus.Pending,
        shipping_name=payload.shipping_name,
        shipping_address=payload.shipping_address,
        tracking_number=_gen_tracking(),
        items=order_items,
        payment_method=payment_method,
        # Cash on Delivery is "unpaid" until it's handed over in person; online
        # methods sit as "pending" until PayMongo's webhook confirms payment
        # (see app/routers/payments.py).
        payment_status="unpaid" if payment_method == "cod" else "pending",
    )
    db.add(order)

    # Loyalty points: 1 point per currency unit spent (adjust as needed)
    current_user.loyalty_points = (current_user.loyalty_points or 0) + int(total)

    db.add(
        models.Notification(
            user_id=current_user.id,
            title="Order Placed",
            message=f"Your order {order.order_number} has been placed and is pending confirmation.",
            type="processing",
        )
    )

    db.commit()
    db.refresh(order)
    return order


@router.get("", response_model=List[schemas.OrderOut])
def list_orders(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Customers see their own orders; admins see all orders."""
    query = db.query(models.Order)
    if current_user.role != models.Role.admin:
        query = query.filter(models.Order.user_id == current_user.id)
    return query.order_by(models.Order.created_at.desc()).all()


@router.get("/{order_id}", response_model=schemas.OrderOut)
def get_order(
    order_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if current_user.role != models.Role.admin and order.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to view this order")
    return order


@router.patch("/{order_id}/status", response_model=schemas.OrderOut)
def update_order_status(
    order_id: int,
    payload: schemas.OrderStatusUpdate,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    valid_statuses = [s.value for s in models.OrderStatus]
    if payload.status not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Status must be one of {valid_statuses}")

    order.status = models.OrderStatus(payload.status)
    if payload.status == "Delivered":
        order.delivered_at = datetime.utcnow()      # used by the Deliveries map ("delivered today")

    type_map = {"Processing": "processing", "Shipped": "shipped", "Delivered": "delivered"}
    if payload.status in type_map:
        label = STATUS_LABELS.get(payload.status, payload.status)
        db.add(
            models.Notification(
                user_id=order.user_id,
                title=f"Order {label}",
                message=f"Your order {order.order_number} is now {label.lower()}.",
                type=type_map[payload.status],
            )
        )

    db.commit()
    db.refresh(order)
    if payload.status == "Shipped" and order.dest_lat is None:
        schedule_geocode(order.id)      # find the delivery address on the map (in the background)
    return order


@router.post("/{order_id}/packed", response_model=schemas.OrderOut)
def mark_order_packed(
    order_id: int,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    """Staff mark an order as packed (items finished packaging) while it is still in
    Processing. The customer gets a notification that it is ready for delivery."""
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.status != models.OrderStatus.Processing:
        raise HTTPException(status_code=400, detail="Only orders in Processing can be marked as packed")
    if order.packed_at:
        raise HTTPException(status_code=400, detail="This order is already marked as packed")

    order.packed_at = datetime.utcnow()
    db.add(
        models.Notification(
            user_id=order.user_id,
            title="Order Packed",
            message=f"Good news! Your order {order.order_number} has been packed and is ready for delivery.",
            type="processing",
        )
    )
    db.commit()
    db.refresh(order)
    return order


@router.post("/{order_id}/cancel", response_model=schemas.OrderOut)
def cancel_order(
    order_id: int,
    payload: schemas.OrderCancelIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Lets a customer cancel their own order while it's still Pending,
    recording why. Restores stock for every item since nothing shipped."""
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if current_user.role != models.Role.admin and order.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to cancel this order")
    if order.status != models.OrderStatus.Pending:
        raise HTTPException(status_code=400, detail="Only pending orders can be cancelled")
    if not payload.reason or not payload.reason.strip():
        raise HTTPException(status_code=400, detail="Please provide a reason for cancelling")

    for item in order.items:
        if item.product_id:
            product = db.query(models.Product).filter(models.Product.id == item.product_id).first()
            if product:
                product.stock += item.quantity

    order.status = models.OrderStatus.Cancelled
    order.cancel_reason = payload.reason.strip()

    db.add(
        models.Notification(
            user_id=order.user_id,
            title="Order Cancelled",
            message=f"Your order {order.order_number} has been cancelled.",
            type="info",
        )
    )

    db.commit()
    db.refresh(order)
    return order


# ─────────── REVIEWS ───────────
MAX_REVIEW_IMAGES = 3
MAX_REVIEW_IMAGE_CHARS = 1_500_000   # ~1.1 MB per base64 image; frontend sends ~100-200 KB
MAX_REVIEW_COMMENT = 1000


@router.post("/{order_id}/review", response_model=schemas.ReviewOut)
def create_review(
    order_id: int,
    payload: schemas.ReviewCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    """Customer reviews their own order. Allowed once the admin has set it to
    Shipped ("Delivering") or Delivered. One review per order."""
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only review your own orders")
    if order.status not in (models.OrderStatus.Shipped, models.OrderStatus.Delivered):
        raise HTTPException(status_code=400, detail="You can review an order once it is on its way")
    if order.review:
        raise HTTPException(status_code=409, detail="You already reviewed this order")

    if not 1 <= payload.stars <= 5:
        raise HTTPException(status_code=400, detail="Stars must be between 1 and 5")

    comment = (payload.comment or "").strip()
    if len(comment) > MAX_REVIEW_COMMENT:
        raise HTTPException(status_code=400, detail=f"Comment must be {MAX_REVIEW_COMMENT} characters or fewer")

    if len(payload.images) > MAX_REVIEW_IMAGES:
        raise HTTPException(status_code=400, detail=f"You can attach up to {MAX_REVIEW_IMAGES} photos")
    for img in payload.images:
        if not img.startswith("data:image/"):
            raise HTTPException(status_code=400, detail="Review photos must be images")
        if len(img) > MAX_REVIEW_IMAGE_CHARS:
            raise HTTPException(status_code=400, detail="A review photo is too large")

    review = models.OrderReview(
        order_id=order.id,
        user_id=current_user.id,
        stars=payload.stars,
        comment=comment,
        images_json=json.dumps(payload.images),
    )
    db.add(review)

    # Feed the order's stars into each product's rating (one rating per user per
    # product: update it if the customer has already rated that product).
    for item in order.items:
        if not item.product_id:
            continue
        rating = (
            db.query(models.Rating)
            .filter(models.Rating.user_id == current_user.id, models.Rating.product_id == item.product_id)
            .first()
        )
        if rating:
            rating.stars = payload.stars
        else:
            db.add(models.Rating(user_id=current_user.id, product_id=item.product_id, stars=payload.stars))

    db.commit()
    db.refresh(review)
    return review
