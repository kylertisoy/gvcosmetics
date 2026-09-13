"""
Lets an admin send a one-off custom email to a customer from the
Customer Analysis panel (the "📧 Email" button and its compose modal
in the frontend). Uses the same Brevo integration as payments.py's
payment confirmation email.

No new env vars needed beyond the BREVO_* ones already set up in
app/emails.py.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr

from .. import models
from ..auth import get_current_admin
from ..emails import send_custom_email

router = APIRouter(prefix="/customers", tags=["customers-email"])


class CustomEmailRequest(BaseModel):
    email: EmailStr
    name: str
    subject: str
    message: str


@router.post("/send-email")
def send_email_to_customer(
    payload: CustomEmailRequest,
    admin: models.User = Depends(get_current_admin),
):
    if not payload.subject.strip() or not payload.message.strip():
        raise HTTPException(400, "Subject and message are required")

    success = send_custom_email(
        to_email=payload.email,
        to_name=payload.name,
        subject=payload.subject,
        message=payload.message,
    )
    if not success:
        raise HTTPException(502, "Brevo failed to send the email — check the backend console for the [Brevo] error line")

    return {"sent": True}
