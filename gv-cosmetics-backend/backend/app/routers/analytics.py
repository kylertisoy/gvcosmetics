from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas, auth
from ..database import get_db
from .customers import _segment

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/dashboard", response_model=schemas.DashboardStats)
def dashboard(
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    total_revenue = db.query(func.coalesce(func.sum(models.Order.total), 0)).scalar()
    total_orders = db.query(func.count(models.Order.id)).scalar()
    pending_orders = (
        db.query(func.count(models.Order.id))
        .filter(models.Order.status == models.OrderStatus.Pending)
        .scalar()
    )
    total_customers = (
        db.query(func.count(models.User.id)).filter(models.User.role == models.Role.customer).scalar()
    )

    status_rows = (
        db.query(models.Order.status, func.count(models.Order.id))
        .group_by(models.Order.status)
        .all()
    )
    status_breakdown = {s.value: c for s, c in status_rows}

    return schemas.DashboardStats(
        total_revenue=float(total_revenue),
        total_orders=total_orders,
        pending_orders=pending_orders,
        total_customers=total_customers,
        status_breakdown=status_breakdown,
    )


@router.get("", response_model=schemas.AnalyticsOut)
def analytics(
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    status_rows = (
        db.query(models.Order.status, func.coalesce(func.sum(models.Order.total), 0))
        .group_by(models.Order.status)
        .all()
    )
    revenue_by_status = {s.value: float(rev) for s, rev in status_rows}

    order_counts = (
        db.query(models.Order.user_id, func.count(models.Order.id))
        .group_by(models.Order.user_id)
        .all()
    )
    seg_counts = {"Loyal": 0, "Occasional": 0, "New": 0}
    for _, count in order_counts:
        seg_counts[_segment(count)] += 1

    top_rows = (
        db.query(
            models.OrderItem.product_name,
            func.sum(models.OrderItem.quantity).label("qty"),
            func.sum(models.OrderItem.quantity * models.OrderItem.unit_price).label("rev"),
        )
        .group_by(models.OrderItem.product_name)
        .order_by(func.sum(models.OrderItem.quantity).desc())
        .limit(5)
        .all()
    )
    top_products = [
        {"name": r.product_name, "quantity": int(r.qty), "revenue": float(r.rev)} for r in top_rows
    ]

    return schemas.AnalyticsOut(
        revenue_by_status=revenue_by_status,
        customer_segments=seg_counts,
        top_products=top_products,
    )
