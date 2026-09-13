import random
import string
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas, auth
from ..database import get_db

router = APIRouter(prefix="/orders", tags=["orders"])

VALID_PAYMENT_METHODS = {"cod", "gcash", "card", "maya"}


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

    total = 0.0
    order_items = []
    for item in payload.items:
        product = db.query(models.Product).filter(models.Product.id == item.product_id).first()
        if not product:
            raise HTTPException(status_code=404, detail=f"Product {item.product_id} not found")
        if item.quantity < 1:
            raise HTTPException(status_code=400, detail="Quantity must be at least 1")
        if product.stock < item.quantity:
            raise HTTPException(status_code=400, detail=f"Not enough stock for {product.name}")

        subtotal = product.price * item.quantity
        total += subtotal
        product.stock -= item.quantity
        order_items.append(
            models.OrderItem(
                product_id=product.id,
                product_name=product.name,
                unit_price=product.price,
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

    type_map = {"Processing": "processing", "Shipped": "shipped", "Delivered": "delivered"}
    if payload.status in type_map:
        db.add(
            models.Notification(
                user_id=order.user_id,
                title=f"Order {payload.status}",
                message=f"Your order {order.order_number} is now {payload.status.lower()}.",
                type=type_map[payload.status],
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
