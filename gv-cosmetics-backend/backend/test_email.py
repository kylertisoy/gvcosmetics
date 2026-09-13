"""
Quick standalone test for the Brevo email integration.
Run this from your backend folder (with the venv active) to confirm Brevo
is actually configured correctly, without needing to place a real order
or set up PayMongo/ngrok first.

Usage:
    python test_email.py your-real-email@example.com
"""

import sys

from dotenv import load_dotenv
load_dotenv()

from app.emails import send_payment_confirmation_email

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python test_email.py your-real-email@example.com")
        sys.exit(1)

    to_email = sys.argv[1]

    print(f"Sending a test email to {to_email} ...")
    success = send_payment_confirmation_email(
        to_email=to_email,
        to_name="Test Customer",
        order_number="ORD-TEST",
        amount=999.00,
    )

    if success:
        print("✅ Brevo accepted the email. Check the inbox (and spam folder) for", to_email)
    else:
        print("❌ Brevo rejected it or the request failed. Check the [Brevo] error line printed above this.")
