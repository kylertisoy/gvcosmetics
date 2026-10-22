"""
Automatic emails about an order: one to the customer at each step, one to the rider when
they are given a delivery. They go out through the same Brevo helper as every other email
(app/emails.py -> send_custom_email), so they work on Render's free plan and reach Gmail or
any other address.

  * Emails are sent in a background thread, so a slow email service never slows down an order.
  * A problem sending an email is only printed in the logs ("[notify] ..."); it never breaks
    placing an order, a status change or a delivery.
  * Set ORDER_EMAILS=off on Render to switch every email in this file off.

The rider's email contains a link to their personal page (rider.html?t=TOKEN). It needs the
website's address, which is found in this order:
  1. the SITE_URL environment variable,
  2. the address the admin's browser saved when the Deliveries screen was opened,
  3. the first address in CORS_ORIGINS (unless it is "*").
"""
import os
import threading

from .emails import send_custom_email

KEY_SITE_URL = "site_url"


def enabled() -> bool:
    return os.getenv("ORDER_EMAILS", "on").strip().lower() not in ("off", "0", "false", "no")


# ───────────── website address (for links in emails) ─────────────
def site_url(db=None) -> str:
    url = (os.getenv("SITE_URL") or "").strip().rstrip("/")
    if not url and db is not None:
        try:
            from . import models
            row = db.query(models.AppSetting).filter(models.AppSetting.key == KEY_SITE_URL).first()
            url = ((row.value if row else "") or "").strip().rstrip("/")
        except Exception:
            url = ""
    if not url:
        for origin in (os.getenv("CORS_ORIGINS") or "").split(","):
            origin = origin.strip().rstrip("/")
            if origin.startswith("http"):
                url = origin
                break
    return url


def save_site_url(db, url: str) -> None:
    """Remembers the website's address (called from the admin Deliveries screen). Caller commits."""
    from . import models
    row = db.query(models.AppSetting).filter(models.AppSetting.key == KEY_SITE_URL).first()
    if row:
        row.value = url
    else:
        db.add(models.AppSetting(key=KEY_SITE_URL, value=url))


# ───────────── sending ─────────────
def _send(to_email, to_name, subject, message) -> None:
    try:
        if not send_custom_email(to_email=to_email, to_name=to_name, subject=subject, message=message):
            print(f"[notify] the email service did not send '{subject}' to {to_email}")
    except Exception as e:
        print(f"[notify] sending '{subject}' to {to_email} failed: {e}")


def send_async(to_email, to_name, subject, message) -> bool:
    if not to_email or not enabled():
        return False
    threading.Thread(target=_send, args=(to_email, to_name, subject, message), daemon=True, name="order-email").start()
    return True


# ───────────── wording ─────────────
def _peso(n) -> str:
    return f"₱{float(n or 0):,.2f}"


def _items(order) -> str:
    return ", ".join(f"{i.quantity} × {i.product_name}" for i in order.items)


def customer_message(order, name, event, rider=None, reason=None, site=""):
    """(subject, text) for a customer email, or None for an unknown event."""
    no = order.order_number
    first = ((name or "").split() or ["there"])[0]
    track = f"\n\nSee it on our website (open My Orders): {site}" if site else ""
    bye = "\n\nGV Cosmetics"
    if event == "placed":
        return (f"We received your order {no}",
                f"Hi {first},\n\nThank you for your order! We received order {no}:\n  {_items(order)}\n  Total: {_peso(order.total)}"
                f"\n\nWe'll email you again as it moves along.{track}{bye}")
    if event == "processing":
        return (f"Your order {no} is being prepared",
                f"Hi {first},\n\nGood news! We are now preparing the items in your order {no}.{track}{bye}")
    if event == "packed":
        return (f"Your order {no} is packed",
                f"Hi {first},\n\nYour order {no} is packed and ready for delivery. We are arranging a rider.{track}{bye}")
    if event == "for_delivery":
        return (f"Your order {no} is ready for delivery",
                f"Hi {first},\n\nYour order {no} is ready for delivery. We are finding a rider for you, and we'll email you "
                f"again as soon as a rider has your order.{track}{bye}")
    if event == "rider":
        who = rider.name if rider else "A rider"
        phone = f"\nYou can reach them at {rider.phone}." if rider and rider.phone else ""
        live = "\n\nYou can follow the rider on a live map in My Orders on our website" + (f": {site}" if site else ".")
        return (f"Your order {no} is on its way",
                f"Hi {first},\n\n{who} has your order {no} and is on the way to you.{phone}\n"
                f"Please keep your phone nearby: the rider may call you when they arrive.{live}{bye}")
    if event == "delivered":
        return (f"Your order {no} was delivered",
                f"Hi {first},\n\nYour order {no} was delivered. Thank you for shopping with GV Cosmetics!\n\n"
                f"You can now rate your order and add photos in My Orders.{track}{bye}")
    if event == "cancelled":
        why = f"\nReason: {reason}" if reason else ""
        return (f"Your order {no} was cancelled",
                f"Hi {first},\n\nYour order {no} has been cancelled.{why}\n\nIf this is a mistake, please contact us.{bye}")
    return None


def email_customer(order, event, rider=None, reason=None, site="") -> bool:
    """Emails the customer who placed `order` about `event` (see customer_message)."""
    user = getattr(order, "user", None)
    if not user or not getattr(user, "email", None):
        return False
    message = customer_message(order, user.name, event, rider=rider, reason=reason, site=site)
    if not message:
        return False
    return send_async(user.email, user.name, message[0], message[1])


def rider_message(rider_name, orders, link):
    first = ((rider_name or "").split() or ["there"])[0]
    lines = []
    for o in orders:
        cust = getattr(o, "shipping_name", None) or (o.user.name if getattr(o, "user", None) else "Customer")
        cash = ""
        if o.payment_method == "cod" and o.payment_status != "paid":
            cash = f" · collect {_peso(o.total)} cash"
        rush = " (RUSH)" if getattr(o, "is_rush", False) else ""
        lines.append(f"  - {o.order_number}{rush} · {cust} · {o.shipping_address or 'no address'}{cash}")
    count = len(orders)
    subject = f"New delivery: {orders[0].order_number}" if count == 1 else f"{count} new deliveries"
    where = (f"Open your rider page (map, directions, the customer's phone number and the Delivered button):\n{link}"
             if link else "Open your rider page from the link the shop gave you.")
    body = (f"Hi {first},\n\nYou have {'a new delivery' if count == 1 else str(count) + ' new deliveries'} from GV Cosmetics:\n\n"
            + "\n".join(lines) + f"\n\n{where}\n\nThis is your personal link. Please keep it private.\n\nGV Cosmetics")
    return subject, body


def email_rider(rider, orders, link) -> bool:
    """Emails the rider their personal page link with the orders they were just given."""
    if not rider or not getattr(rider, "email", None) or not orders:
        return False
    subject, body = rider_message(rider.name, orders, link)
    return send_async(rider.email, rider.name, subject, body)
