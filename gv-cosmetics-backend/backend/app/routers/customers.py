from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas, auth
from ..database import get_db
from ..emails import send_custom_email

router = APIRouter(prefix="/customers", tags=["customers"])


class CustomerEmailIn(BaseModel):
    subject: str
    message: str


def _segment(order_count: int) -> str:
    if order_count >= 5:
        return "Loyal"
    if order_count >= 2:
        return "Occasional"
    return "New"


@router.get("", response_model=List[schemas.CustomerOut])
def list_customers(
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    rows = (
        db.query(
            models.User.name,
            models.User.email,
            func.count(models.Order.id).label("orders"),
            func.coalesce(func.sum(models.Order.total), 0).label("total"),
        )
        .join(models.Order, models.Order.user_id == models.User.id)
        .filter(models.User.role == models.Role.customer)
        .group_by(models.User.id)
        .all()
    )
    return [
        schemas.CustomerOut(
            name=r.name, email=r.email, orders=r.orders, total=float(r.total), seg=_segment(r.orders)
        )
        for r in rows
    ]


@router.post("/{email}/email")
def email_customer(
    email: str,
    payload: CustomerEmailIn,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    customer = (
        db.query(models.User)
        .filter(models.User.email == email.lower(), models.User.role == models.Role.customer)
        .first()
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")

    sent = send_custom_email(
        to_email=customer.email,
        to_name=customer.name,
        subject=payload.subject,
        message=payload.message,
    )
    if not sent:
        raise HTTPException(status_code=502, detail="Email provider failed to send the message")

    return {"detail": f"Email sent to {customer.name}"}
