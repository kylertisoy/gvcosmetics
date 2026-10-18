"""
Forgot-password flow (customers and admins):

    POST /auth/forgot-password   {email}                          -> emails a 6-digit code
    POST /auth/reset-password    {email, code, new_password}      -> sets the new password

The code is sent with the same Brevo helper the admin "Email" button uses
(app/emails.py -> send_custom_email). Brevo is an HTTPS API, so it also works on
Render's free plan, which blocks normal SMTP / Gmail sending.

Safety rules:
  * the code expires after 10 minutes and can be used once
  * only a hash of the code is stored, never the code itself
  * 5 wrong tries cancel the code
  * a new code can be requested once every 60 seconds
  * /forgot-password gives the same reply whether or not the email has an account,
    so it can't be used to find out who is registered

Adds three columns to `users` (reset_code_hash, reset_code_expires, reset_attempts);
app/main.py creates them automatically on startup.
"""
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, auth
from ..database import get_db
from ..emails import send_custom_email

router = APIRouter(prefix="/auth", tags=["password-reset"])

CODE_MINUTES = 10
RESEND_SECONDS = 60
MAX_ATTEMPTS = 5

GENERIC_REPLY = {"detail": "If that email has an account, a reset code has been sent."}
BAD_CODE = "Invalid or expired code. Please check it or request a new one."


class ForgotPasswordIn(BaseModel):
    email: EmailStr


class ResetPasswordIn(BaseModel):
    email: EmailStr
    code: str
    new_password: str


def _new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def _clear_code(user) -> None:
    user.reset_code_hash = None
    user.reset_code_expires = None
    user.reset_attempts = 0


def _sent_recently(user, now: datetime) -> bool:
    """True if a code was issued less than RESEND_SECONDS ago.
    The send time is derived from the expiry (expires = sent + CODE_MINUTES)."""
    if not user.reset_code_expires:
        return False
    sent_at = user.reset_code_expires - timedelta(minutes=CODE_MINUTES)
    return (now - sent_at).total_seconds() < RESEND_SECONDS


def _find_user(db: Session, email: str):
    email = (email or "").strip().lower()
    return db.query(models.User).filter(func.lower(models.User.email) == email).first()


@router.post("/forgot-password")
def forgot_password(payload: ForgotPasswordIn, db: Session = Depends(get_db)):
    user = _find_user(db, payload.email)
    now = datetime.utcnow()

    # Unknown email, or a code was sent a moment ago: reply the same way, send nothing.
    if not user or _sent_recently(user, now):
        return GENERIC_REPLY

    code = _new_code()
    user.reset_code_hash = auth.hash_password(code)
    user.reset_code_expires = now + timedelta(minutes=CODE_MINUTES)
    user.reset_attempts = 0
    db.commit()

    message = (
        f"Hi {user.name},\n\n"
        f"Your GV Cosmetics password reset code is: {code}\n\n"
        f"It expires in {CODE_MINUTES} minutes. If you didn't ask to reset your password, "
        f"you can ignore this email and your password will stay the same.\n\n"
        f"GV Cosmetics"
    )
    try:
        sent = send_custom_email(
            to_email=user.email,
            to_name=user.name,
            subject="Your GV Cosmetics password reset code",
            message=message,
        )
    except Exception as e:  # network problem etc.
        print(f"[password-reset] sending failed for user {user.id}: {e}")
        sent = False

    if not sent:
        print(f"[password-reset] the email service did not send the code to user {user.id}")
        _clear_code(user)       # nothing was delivered, so let them try again right away
        db.commit()

    return GENERIC_REPLY


@router.post("/reset-password")
def reset_password(payload: ResetPasswordIn, db: Session = Depends(get_db)):
    user = _find_user(db, payload.email)
    now = datetime.utcnow()

    if (
        not user
        or not user.reset_code_hash
        or not user.reset_code_expires
        or user.reset_code_expires < now
    ):
        raise HTTPException(400, BAD_CODE)

    if (user.reset_attempts or 0) >= MAX_ATTEMPTS:
        _clear_code(user)
        db.commit()
        raise HTTPException(400, "Too many wrong attempts. Please request a new code.")

    if not auth.verify_password((payload.code or "").strip(), user.reset_code_hash):
        user.reset_attempts = (user.reset_attempts or 0) + 1
        too_many = user.reset_attempts >= MAX_ATTEMPTS
        if too_many:
            _clear_code(user)
        db.commit()
        if too_many:
            raise HTTPException(400, "Too many wrong attempts. Please request a new code.")
        raise HTTPException(400, BAD_CODE)

    # Code is correct. A weak password is rejected here WITHOUT using up the code,
    # so the customer can just pick a stronger one.
    auth.validate_password_strength(payload.new_password)

    user.password_hash = auth.hash_password(payload.new_password)
    _clear_code(user)
    db.commit()
    return {"detail": "Password updated. You can now sign in with your new password."}
