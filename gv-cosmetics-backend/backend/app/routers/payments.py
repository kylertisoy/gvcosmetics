"""
PayMongo integration for GCash / Card / Maya checkout.

Routes:
  POST /orders/{order_id}/checkout-session  -> called by the frontend right
      after an order is created (skipped for Cash on Delivery). Creates a
      PayMongo Checkout Session and returns its hosted checkout_url.
  POST /webhooks/paymongo -> called by PayMongo itself when the customer
      finishes paying. Verifies the signature, marks the order paid, and
      sends a payment-confirmation email via Brevo.

ENV VARS NEEDED (.env):
  PAYMONGO_SECRET_KEY=sk_test_xxxxxxxxxxxx
  PAYMONGO_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx
  FRONTEND_URL=http://localhost:5500

PayMongo dashboard setup:
  1. https://dashboard.paymongo.com -> Developers > API Keys -> copy Secret Key.
  2. Developers > Webhooks > Add Endpoint:
       URL: https://<your-backend-domain>/webhooks/paymongo
       Event: checkout_session.payment.paid
     Copy the Signing Secret into PAYMONGO_WEBHOOK_SECRET.
  3. GCash / Maya may need enabling under Developers > Payment Methods
     before they show up at checkout (Card works immediately in test mode).

Install the one new dependency:
  pip install httpx --break-system-packages
"""

import base64
import hashlib
import hmac
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..auth import get_current_user
from ..emails import send_payment_confirmation_email

router = APIRouter(tags=["payments"])

PAYMONGO_SECRET_KEY = os.environ["PAYMONGO_SECRET_KEY"]
PAYMONGO_WEBHOOK_SECRET = os.environ["PAYMONGO_WEBHOOK_SECRET"]
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5500")

PAYMONGO_API = "https://api.paymongo.com/v1"

# PayMongo's own name for each method vs. what the frontend sends
PAYMENT_METHOD_MAP = {
    "gcash": "gcash",
    "card": "card",
    "maya": "paymaya",
}


def _paymongo_auth_header() -> dict:
    token = base64.b64encode(f"{PAYMONGO_SECRET_KEY}:".encode()).decode()
    return {"Authorization": f"Basic {token}", "Content-Type": "application/json"}


@router.post("/orders/{order_id}/checkout-session")
async def create_checkout_session(
    order_id: int,
    body: dict,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    payment_method = body.get("payment_method")
    if payment_method not in PAYMENT_METHOD_MAP:
        raise HTTPException(400, "Unsupported payment method")

    order = (
        db.query(models.Order)
        .filter(models.Order.id == order_id, models.Order.user_id == user.id)
        .first()
    )
    if not order:
        raise HTTPException(404, "Order not found")

    amount_in_centavos = int(round(order.total * 100))  # PayMongo wants centavos, not pesos

    payload = {
        "data": {
            "attributes": {
                "billing": {"name": user.name, "email": user.email},
                "send_email_receipt": False,
                "show_description": True,
                "show_line_items": True,
                "line_items": [
                    {
                        "currency": "PHP",
                        "amount": amount_in_centavos,
                        "name": f"Order {order.order_number}",
                        "quantity": 1,
                    }
                ],
                "payment_method_types": [PAYMENT_METHOD_MAP[payment_method]],
                "description": f"GV Cosmetics Order {order.order_number}",
                "success_url": f"{FRONTEND_URL}?payment=success&order={order.order_number}",
                "cancel_url": f"{FRONTEND_URL}?payment=cancelled&order={order.order_number}",
            }
        }
    }

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{PAYMONGO_API}/checkout_sessions",
            headers=_paymongo_auth_header(),
            json=payload,
            timeout=15,
        )

    if resp.status_code >= 300:
        raise HTTPException(502, f"PayMongo error: {resp.text}")

    session = resp.json()["data"]

    order.paymongo_session_id = session["id"]
    order.payment_status = "pending"
    order.payment_method = payment_method
    db.commit()

    return {"checkout_url": session["attributes"]["checkout_url"]}


@router.post("/webhooks/paymongo")
async def paymongo_webhook(request: Request, db: Session = Depends(get_db)):
    raw_body = await request.body()
    signature_header = request.headers.get("Paymongo-Signature", "")

    if not _verify_paymongo_signature(raw_body, signature_header):
        raise HTTPException(400, "Invalid webhook signature")

    event = await request.json()
    event_type = event.get("data", {}).get("attributes", {}).get("type")

    if event_type == "checkout_session.payment.paid":
        session_id = event["data"]["attributes"]["data"]["id"]

        order = (
            db.query(models.Order)
            .filter(models.Order.paymongo_session_id == session_id)
            .first()
        )
        if order:
            order.payment_status = "paid"
            db.commit()
            if order.user:
                send_payment_confirmation_email(
                    to_email=order.user.email,
                    to_name=order.user.name,
                    order_number=order.order_number,
                    amount=order.total,
                )

    return {"received": True}


def _verify_paymongo_signature(raw_body: bytes, signature_header: str) -> bool:
    """
    PayMongo signs webhooks as: t=<timestamp>,te=<test_sig>,li=<live_sig>
    Recompute HMAC-SHA256 of "<timestamp>.<raw_body>" with the webhook secret
    and compare to the signature PayMongo sent.
    """
    try:
        parts = dict(p.split("=", 1) for p in signature_header.split(","))
        timestamp = parts["t"]
        their_sig = parts.get("li") or parts.get("te")
        signed_payload = f"{timestamp}.{raw_body.decode()}"
        expected_sig = hmac.new(
            PAYMONGO_WEBHOOK_SECRET.encode(), signed_payload.encode(), hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(expected_sig, their_sig)
    except Exception:
        return False
