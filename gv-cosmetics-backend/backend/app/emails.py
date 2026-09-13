"""
Brevo (formerly Sendinblue) transactional emails for GV Cosmetics.

WHAT THIS FILE DOES
--------------------
Sends the customer-facing emails your system needs, using Brevo's REST API
(no SMTP setup required — a single HTTPS POST per email):

- send_order_confirmation_email  -> right after an order is placed
- send_payment_confirmation_email -> called by payments.py once PayMongo
                                      confirms the customer paid
- send_delivery_notification_email -> when an admin marks an order Delivered,
                                       or when the customer submits their
                                       proof-of-delivery photo

WHERE TO CALL THESE FROM
--------------------------
- send_order_confirmation_email: call this inside your existing
  POST /orders route, right after the order is successfully created.
- send_payment_confirmation_email: already wired up in payments.py's webhook.
- send_delivery_notification_email: call this inside your existing
  PATCH/PUT order-status route, when the new status is "Delivered".

ENVIRONMENT VARIABLES NEEDED (add to your .env)
------------------------------------------------
BREVO_API_KEY=xkeysib-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BREVO_SENDER_EMAIL=orders@yourdomain.com
BREVO_SENDER_NAME=GV Cosmetics

BREVO DASHBOARD SETUP
------------------------
1. Sign up free at https://www.brevo.com (300 emails/day free tier).
2. SMTP & API > API Keys > Generate a new API key. Copy it into
   BREVO_API_KEY above.
3. Senders, Domains & Dedicated IPs > Senders > add and verify the email
   address you want to send from (BREVO_SENDER_EMAIL). Brevo requires this
   verification step before it will let you send from that address.

Install the one extra dependency this needs (skip if payments.py already
installed it):
    pip install httpx --break-system-packages
"""

import os
import httpx

BREVO_API = "https://api.brevo.com/v3/smtp/email"


def _get_config():
    """Read Brevo config lazily (only when actually sending an email) so a
    missing/misconfigured env var doesn't crash the whole backend at startup —
    it'll just fail (with a clear error) the moment an email is attempted."""
    api_key = os.environ.get("BREVO_API_KEY")
    if not api_key:
        raise RuntimeError("BREVO_API_KEY is not set in your .env file")
    sender_email = os.environ.get("BREVO_SENDER_EMAIL", "orders@gvcosmetics.com")
    sender_name = os.environ.get("BREVO_SENDER_NAME", "GV Cosmetics")
    return api_key, sender_email, sender_name


def _send_email(to_email: str, to_name: str, subject: str, html_content: str) -> bool:
    """Low-level Brevo API call shared by all the templated senders below.
    Returns True on success; logs and swallows errors so a flaky email
    provider never breaks the checkout/admin flow that called it."""
    api_key, sender_email, sender_name = _get_config()
    payload = {
        "sender": {"email": sender_email, "name": sender_name},
        "to": [{"email": to_email, "name": to_name}],
        "subject": subject,
        "htmlContent": html_content,
    }
    headers = {
        "api-key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    try:
        resp = httpx.post(BREVO_API, headers=headers, json=payload, timeout=15)
        if resp.status_code >= 300:
            print(f"[Brevo] Failed to send '{subject}' to {to_email}: {resp.text}")
            return False
        return True
    except Exception as e:
        print(f"[Brevo] Error sending '{subject}' to {to_email}: {e}")
        return False


def send_order_confirmation_email(to_email: str, to_name: str, order_number: str, total: float, address: str) -> bool:
    html = f"""
    <div style="font-family:sans-serif;max-width:480px;margin:auto">
      <h2 style="color:#C2607E">Thanks for your order, {to_name}!</h2>
      <p>We've received order <b>{order_number}</b> and we're getting it ready.</p>
      <p><b>Total:</b> ₱{total:,.2f}<br>
         <b>Delivering to:</b> {address}</p>
      <p>We'll email you again once your payment is confirmed and when your order ships.</p>
      <p style="color:#8A8580;font-size:12px">— GV Cosmetics</p>
    </div>"""
    return _send_email(to_email, to_name, f"Order {order_number} confirmed", html)


def send_payment_confirmation_email(to_email: str, to_name: str, order_number: str, amount: float) -> bool:
    html = f"""
    <div style="font-family:sans-serif;max-width:480px;margin:auto">
      <h2 style="color:#4A8C5C">Payment received ✔</h2>
      <p>Hi {to_name}, we've confirmed your payment of <b>₱{amount:,.2f}</b> for order <b>{order_number}</b>.</p>
      <p>Your order is now being prepared for shipping.</p>
      <p style="color:#8A8580;font-size:12px">— GV Cosmetics</p>
    </div>"""
    return _send_email(to_email, to_name, f"Payment received for order {order_number}", html)


def send_delivery_notification_email(to_email: str, to_name: str, order_number: str) -> bool:
    html = f"""
    <div style="font-family:sans-serif;max-width:480px;margin:auto">
      <h2 style="color:#C2607E">Your order has arrived!</h2>
      <p>Hi {to_name}, order <b>{order_number}</b> has been marked as delivered.</p>
      <p>We'd love to hear what you think — you can rate your order from the My Orders page.</p>
      <p style="color:#8A8580;font-size:12px">— GV Cosmetics</p>
    </div>"""
    return _send_email(to_email, to_name, f"Order {order_number} delivered", html)


def send_custom_email(to_email: str, to_name: str, subject: str, message: str) -> bool:
    """Used by the admin panel's Customer Analysis > Email button, where an
    admin writes a free-form subject and message for a specific customer."""
    # Preserve line breaks the admin typed, since textareas send plain text
    message_html = message.replace("\n", "<br>")
    html = f"""
    <div style="font-family:sans-serif;max-width:480px;margin:auto">
      <p>Hi {to_name},</p>
      <p>{message_html}</p>
      <p style="color:#8A8580;font-size:12px">— GV Cosmetics</p>
    </div>"""
    return _send_email(to_email, to_name, subject, html)

