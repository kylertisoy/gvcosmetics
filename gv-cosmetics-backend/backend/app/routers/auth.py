import random
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from typing import List

from .. import models, schemas, auth, emails
from ..database import get_db

router = APIRouter(prefix="/auth", tags=["auth"])

CODE_VALID_MINUTES = 15


def _initials(name: str) -> str:
    parts = name.strip().split()
    if not parts:
        return "U"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def _generate_and_send_code(user: models.User, db: Session):
    """Sets a fresh 6-digit code (15 min expiry) on the user and emails it.
    A Brevo/network hiccup here is swallowed — the account still gets
    created, and the customer can use 'Resend Code' once it's sorted out."""
    code = f"{random.randint(0, 999999):06d}"
    user.verification_code = code
    user.verification_code_expires = datetime.utcnow() + timedelta(minutes=CODE_VALID_MINUTES)
    db.commit()
    try:
        emails.send_verification_email(user.email, user.name, code)
    except Exception as e:
        print(f"[auth] Could not send verification email to {user.email}: {e}")


@router.post("/register", response_model=schemas.RegisterOut)
def register(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    email = payload.email.lower()
    existing = db.query(models.User).filter(models.User.email == email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    user = models.User(
        email=email,
        password_hash=auth.hash_password(payload.password),
        name=payload.name,
        initials=_initials(payload.name),
        role=models.Role.customer,
        approval_status="pending",
        email_verified=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    _generate_and_send_code(user, db)

    # No token is issued — customer accounts need to verify their email AND
    # be approved by an admin before they can log in.
    return schemas.RegisterOut(
        detail="Account created. Check your email for a 6-digit verification code, then wait for an admin to approve your account before signing in.",
        approval_status=user.approval_status,
    )


@router.post("/verify-email", response_model=schemas.RegisterOut)
def verify_email(payload: schemas.VerifyEmailIn, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == payload.email.lower()).first()
    if not user:
        raise HTTPException(status_code=404, detail="No account found with that email")
    if user.email_verified:
        return schemas.RegisterOut(detail="Your email is already verified.", approval_status=user.approval_status)
    if not user.verification_code or user.verification_code != payload.code.strip():
        raise HTTPException(status_code=400, detail="Incorrect verification code")
    if not user.verification_code_expires or datetime.utcnow() > user.verification_code_expires:
        raise HTTPException(status_code=400, detail="This code has expired. Please request a new one.")

    user.email_verified = True
    user.verification_code = None
    user.verification_code_expires = None
    db.commit()
    return schemas.RegisterOut(detail="Email verified! Once an admin approves your account, you can sign in.", approval_status=user.approval_status)


@router.post("/resend-verification")
def resend_verification(payload: schemas.ResendCodeIn, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == payload.email.lower()).first()
    if not user:
        raise HTTPException(status_code=404, detail="No account found with that email")
    if user.email_verified:
        raise HTTPException(status_code=400, detail="This email is already verified.")

    _generate_and_send_code(user, db)
    return {"detail": "A new verification code has been sent."}


@router.post("/login", response_model=schemas.Token)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == form_data.username.lower()).first()
    if not user or not auth.verify_password(form_data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Admin accounts are never gated by email_verified/approval_status — only customer signups are.
    if user.role == models.Role.customer:
        if not user.email_verified:
            raise HTTPException(status_code=403, detail="Please verify your email before signing in. Check your inbox for the code, or request a new one.")
        if user.approval_status != "approved":
            if user.approval_status == "rejected":
                raise HTTPException(status_code=403, detail="Your account registration was rejected. Please contact support.")
            raise HTTPException(status_code=403, detail="Your account is awaiting admin approval. Please check back later.")

    token = auth.create_access_token({"sub": str(user.id)})
    return schemas.Token(access_token=token, user=schemas.UserOut.model_validate(user))


@router.get("/me", response_model=schemas.UserOut)
def get_me(current_user: models.User = Depends(auth.get_current_user)):
    return current_user


@router.post("/change-password")
def change_password(
    payload: schemas.PasswordChange,
    current_user: models.User = Depends(auth.get_current_user),
    db: Session = Depends(get_db),
):
    if not auth.verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    current_user.password_hash = auth.hash_password(payload.new_password)
    db.commit()
    return {"detail": "Password updated"}


# ─────────── ADMIN: CUSTOMER SIGNUP APPROVALS ───────────
@router.get("/pending-customers", response_model=List[schemas.UserOut])
def list_pending_customers(
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    return (
        db.query(models.User)
        .filter(models.User.role == models.Role.customer, models.User.approval_status == "pending")
        .order_by(models.User.created_at.desc())
        .all()
    )


@router.post("/approve/{user_id}", response_model=schemas.UserOut)
def approve_customer(
    user_id: int,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.approval_status = "approved"
    db.commit()
    db.refresh(user)
    return user


@router.post("/reject/{user_id}", response_model=schemas.UserOut)
def reject_customer(
    user_id: int,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.approval_status = "rejected"
    db.commit()
    db.refresh(user)
    return user