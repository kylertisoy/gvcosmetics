"""
Expiry alert emails for the admin Inventory page.

  GET  /inventory/alert-settings          -> who gets the emails + when the last one was sent
  PUT  /inventory/alert-settings          -> save the recipient email address(es)
  POST /inventory/expiry-alerts/send      -> check now; {"force": true} resends the full list
  GET  /inventory/expiry-alerts/cron?key= -> optional daily trigger for an outside scheduler

It runs BY ITSELF - nobody needs to press a button:
  * shortly after the server starts (a sleeping free Render server also "starts" again
    whenever someone visits the shop), and
  * every EXPIRY_ALERT_INTERVAL_HOURS (default 6) while the server stays awake,
  * plus whenever an admin logs in or opens Inventory, and
  * optionally from an outside daily scheduler through the /cron address below, which
    covers quiet days when the free server is asleep and nobody visits.
Set EXPIRY_ALERTS_AUTO=off to switch the automatic timer off.

What triggers an email: a product with stock that is within 30 days of its expiry date
("near expiry"), or past it ("expired"). Each product is reported ONCE per state and
expiry date, so opening the page again does not send the same email twice. If an expiry
date is changed (restocked), or a near-expiry product later expires, it is reported again.

Emails go out through the same Brevo helper as everything else (app/emails.py ->
send_custom_email), so they work on Render's free plan. They can be delivered to any
address, including Gmail. If no address has been saved, the admin's own login email is used.

Two small tables are added (app_settings, expiry_alert_log). create_all() builds them
automatically on startup.
"""
import os
import secrets
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from .. import models, auth
from ..database import get_db, SessionLocal
from ..emails import send_custom_email

router = APIRouter(prefix="/inventory", tags=["inventory-alerts"])

NEAR_EXPIRY_DAYS = 30        # same window the Inventory page uses
MAX_RECIPIENTS = 5
KEY_EMAILS = "expiry_alert_emails"
KEY_LAST_SENT = "expiry_alert_last_sent"
KEY_LAST_CHECK = "expiry_alert_last_check"

# Philippines is UTC+8 all year (no daylight saving)
PH_TZ = timezone(timedelta(hours=8))


def _today_ph() -> date:
    return datetime.now(PH_TZ).date()


class AlertSettingsIn(BaseModel):
    emails: List[EmailStr] = []


class SendAlertsIn(BaseModel):
    force: bool = False


# ───────────── small key/value settings store ─────────────
def _get_setting(db: Session, key: str):
    row = db.query(models.AppSetting).filter(models.AppSetting.key == key).first()
    return row.value if row else None


def _set_setting(db: Session, key: str, value: str) -> None:
    row = db.query(models.AppSetting).filter(models.AppSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(models.AppSetting(key=key, value=value))


def _saved_emails(db: Session) -> List[str]:
    raw = _get_setting(db, KEY_EMAILS) or ""
    return [e.strip() for e in raw.split(",") if e.strip()]


# ───────────── deciding what to report ─────────────
def classify(products, today: date):
    """Split products (that still have stock) into (expired, near_expiry), soonest first.
    Each item is (product, days_left). Expired means the day AFTER the expiry date."""
    expired, near = [], []
    for p in products:
        if not p.expiry_date or (p.stock or 0) <= 0:
            continue
        days = (p.expiry_date - today).days
        if days < 0:
            expired.append((p, days))
        elif days <= NEAR_EXPIRY_DAYS:
            near.append((p, days))
    expired.sort(key=lambda t: t[0].expiry_date)
    near.sort(key=lambda t: t[0].expiry_date)
    return expired, near


def _fmt(d: date) -> str:
    return d.strftime("%b %d, %Y")


def _days(n: int) -> str:
    return f"{n} day" if n == 1 else f"{n} days"


def build_message(expired, near) -> str:
    lines = ["Hello,", "", "This is an automatic inventory alert from GV Cosmetics.", ""]
    if expired:
        lines.append("EXPIRED (take these off the shelf):")
        for p, days in expired:
            lines.append(f"  - {p.name}: expired {_fmt(p.expiry_date)} ({_days(abs(days))} ago), {p.stock} in stock")
        lines.append("")
    if near:
        lines.append(f"NEAR EXPIRY (within {NEAR_EXPIRY_DAYS} days):")
        for p, days in near:
            when = "today" if days == 0 else f"in {_days(days)}"
            lines.append(f"  - {p.name}: expires {_fmt(p.expiry_date)} ({when}), {p.stock} in stock")
        lines.append("")
    lines += ["Open the Inventory page in the admin panel to review these items.", "", "GV Cosmetics"]
    return "\n".join(lines)


def run_expiry_alerts(db: Session, fallback_email, force: bool = False) -> dict:
    """Finds products that are near expiry / expired and emails the recipients.
    force=False reports only what hasn't been reported yet; force=True reports everything."""
    today = _today_ph()
    if not force:
        _set_setting(db, KEY_LAST_CHECK, datetime.utcnow().isoformat())   # "last automatic check" on the page
    expired, near = classify(db.query(models.Product).all(), today)

    logged = {(l.product_id, l.state, l.expiry_date) for l in db.query(models.ExpiryAlertLog).all()}
    if not force:
        expired = [t for t in expired if (t[0].id, "expired", t[0].expiry_date) not in logged]
        near = [t for t in near if (t[0].id, "near", t[0].expiry_date) not in logged]

    summary = {"sent": False, "expired": len(expired), "near": len(near), "recipients": []}
    if not expired and not near:
        summary["reason"] = "nothing_to_report" if force else "nothing_new"
        db.commit()
        return summary

    recipients = _saved_emails(db) or ([fallback_email] if fallback_email else [])
    if not recipients:
        summary["reason"] = "no_recipient"
        db.commit()
        return summary

    subject = f"[GV Cosmetics] Expiry alert: {len(expired)} expired, {len(near)} near expiry"
    message = build_message(expired, near)
    delivered = []
    for addr in recipients:
        try:
            ok = send_custom_email(to_email=addr, to_name="Admin", subject=subject, message=message)
        except Exception as e:
            print(f"[expiry-alert] sending to {addr} failed: {e}")
            ok = False
        if ok:
            delivered.append(addr)

    if not delivered:
        # Nothing went out, so don't mark anything as reported: it will be tried again.
        print("[expiry-alert] the email service did not send the alert")
        summary["reason"] = "send_failed"
        db.commit()
        return summary

    for p, _ in expired:
        if (p.id, "expired", p.expiry_date) not in logged:
            db.add(models.ExpiryAlertLog(product_id=p.id, state="expired", expiry_date=p.expiry_date))
    for p, _ in near:
        if (p.id, "near", p.expiry_date) not in logged:
            db.add(models.ExpiryAlertLog(product_id=p.id, state="near", expiry_date=p.expiry_date))
    _set_setting(db, KEY_LAST_SENT, datetime.utcnow().isoformat())
    db.commit()

    summary.update(sent=True, recipients=delivered)
    return summary


# ───────────── automatic checking ─────────────
def run_scheduled_check() -> None:
    """One automatic check with its own database session (used by the background timer)."""
    db = SessionLocal()
    try:
        admin = db.query(models.User).filter(models.User.role == models.Role.admin).first()
        result = run_expiry_alerts(db, admin.email if admin else None, force=False)
        if result.get("sent"):
            print(f"[expiry-alert] automatic alert sent to {result['recipients']}")
    except Exception as e:      # never let a failed check take the server down
        print(f"[expiry-alert] automatic check failed: {e}")
        try:
            db.rollback()
        except Exception:
            pass
    finally:
        db.close()


_scheduler_started = False


def start_scheduler(first_delay_seconds: int = 30) -> None:
    """Starts the background timer (called once from main.py). It checks shortly after the
    server starts, then every EXPIRY_ALERT_INTERVAL_HOURS (default 6) while it stays awake."""
    global _scheduler_started
    if _scheduler_started:
        return
    if os.getenv("EXPIRY_ALERTS_AUTO", "on").strip().lower() in ("off", "0", "false", "no"):
        return
    _scheduler_started = True
    try:
        hours = max(1.0, float(os.getenv("EXPIRY_ALERT_INTERVAL_HOURS", "6")))
    except ValueError:
        hours = 6.0

    def loop():
        time.sleep(first_delay_seconds)          # let the app finish starting up first
        while True:
            run_scheduled_check()
            time.sleep(hours * 3600)

    threading.Thread(target=loop, name="expiry-alerts", daemon=True).start()


# ───────────── endpoints ─────────────
@router.get("/alert-settings")
def get_alert_settings(
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    return {
        "emails": _saved_emails(db),
        "default_email": admin.email,
        "last_sent_at": _get_setting(db, KEY_LAST_SENT),
        "last_checked_at": _get_setting(db, KEY_LAST_CHECK),
        "near_days": NEAR_EXPIRY_DAYS,
    }


@router.put("/alert-settings")
def save_alert_settings(
    payload: AlertSettingsIn,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    emails: List[str] = []
    for e in payload.emails:
        e = str(e).strip().lower()
        if e and e not in emails:
            emails.append(e)
    if len(emails) > MAX_RECIPIENTS:
        raise HTTPException(400, f"You can add up to {MAX_RECIPIENTS} email addresses.")
    _set_setting(db, KEY_EMAILS, ",".join(emails))
    db.commit()
    return {"emails": emails}


@router.post("/expiry-alerts/send")
def send_expiry_alerts(
    payload: SendAlertsIn,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    return run_expiry_alerts(db, admin.email, force=payload.force)


@router.get("/expiry-alerts/cron")
def cron_expiry_alerts(key: str = "", db: Session = Depends(get_db)):
    """Optional: lets a free outside scheduler (for example cron-job.org) call this once a
    day so alerts go out even when nobody opens the admin page. It is switched off unless
    the ALERT_CRON_KEY environment variable is set, and the ?key= must match it."""
    expected = os.getenv("ALERT_CRON_KEY", "")
    if not expected or not secrets.compare_digest(key.encode(), expected.encode()):
        raise HTTPException(404, "Not found")
    admin = db.query(models.User).filter(models.User.role == models.Role.admin).first()
    return run_expiry_alerts(db, admin.email if admin else None, force=False)
