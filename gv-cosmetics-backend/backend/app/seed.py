"""
Seeds the database with the same starter data that used to live as hardcoded
JS arrays (ACCOUNTS / PRODUCTS) in gvci_updated.html.

Run with:  python -m app.seed
"""
from .database import SessionLocal, Base, engine
from . import models, auth

PRODUCTS = [
    {"id": 1, "name": "Michael Styling Gel Sachet 10g", "category": "Hair Care", "price": 1.85, "stock": 600, "emoji": "💈", "description": "Michael Styling Gel in a convenient 10g sachet. Assorted colors. Per pack of 600.", "badge": "hot"},
    {"id": 2, "name": "Michael Styling Gel Sachet 16g", "category": "Hair Care", "price": 2.30, "stock": 600, "emoji": "💈", "description": "Michael Styling Gel 16g sachet for stronger hold. Assorted colors. Per pack of 600.", "badge": ""},
    {"id": 3, "name": "Shine N' Free Gel Sachet 10g", "category": "Hair Care", "price": 1.67, "stock": 600, "emoji": "✨", "description": "Shine N' Free Gel Sachet 10g — light hold with a brilliant shine. Assorted.", "badge": "new"},
    {"id": 4, "name": "Shine N' Free Gel Sachet 16g", "category": "Hair Care", "price": 2.00, "stock": 600, "emoji": "✨", "description": "Shine N' Free Gel Sachet 16g — medium hold, long-lasting shine.", "badge": ""},
    {"id": 5, "name": "Michael Styling Tube 50ml", "category": "Hair Care", "price": 15.80, "stock": 144, "emoji": "💆", "description": "Michael Styling Tube 50ml. Available in Pink, Yellow, Green, Blue, White & Orange.", "badge": "hot"},
    {"id": 6, "name": "Michael Styling Tube 125ml", "category": "Hair Care", "price": 27.40, "stock": 60, "emoji": "💆", "description": "Michael Styling Tube 125ml — larger size for heavy daily use. Multiple colors.", "badge": ""},
    {"id": 7, "name": "Shine N' Free Gel Tube 50ml", "category": "Hair Care", "price": 12.30, "stock": 144, "emoji": "🌟", "description": "Shine N' Free Gel Tube 50ml — brilliant shine with flexible hold. 6 colors.", "badge": "new"},
    {"id": 8, "name": "Shine N' Free Gel Tube 100ml", "category": "Hair Care", "price": 21.65, "stock": 60, "emoji": "🌟", "description": "Shine N' Free Gel Tube 100ml — extra value size. Pink, Yellow, White, Green, Orange, Blue.", "badge": ""},
    {"id": 9, "name": "M Hair Spray Pump Pink 60ml", "category": "Hair Care", "price": 7200 / 15, "stock": 15, "emoji": "🌸", "description": "Michael Hair Spray Pump in Pink, 60ml. Professional pump dispenser.", "badge": "new"},
    {"id": 10, "name": "M Hair Spray Pump White 60ml", "category": "Hair Care", "price": 6818 / 15, "stock": 15, "emoji": "🤍", "description": "Michael Hair Spray Pump in White, 60ml. Professional pump dispenser.", "badge": "new"},
    {"id": 11, "name": "M Hair Spray Pump Pink 125ml", "category": "Hair Care", "price": 3888 / 15, "stock": 15, "emoji": "🌸", "description": "Michael Hair Spray Pump in Pink, 125ml — larger size for salon use.", "badge": ""},
    {"id": 12, "name": "M Hair Spray Pump White 125ml", "category": "Hair Care", "price": 3474 / 15, "stock": 15, "emoji": "🤍", "description": "Michael Hair Spray Pump in White, 125ml.", "badge": ""},
    {"id": 13, "name": "Michael Isopropyl Alcohol 70% 90ml", "category": "Alcohol", "price": 21.70, "stock": 72, "emoji": "🧴", "description": "Michael Isopropyl Rubbing Alcohol 70% Green — 90ml bottle. Fast-drying & effective.", "badge": "hot"},
    {"id": 14, "name": "Michael Isopropyl Alcohol 70% 180ml", "category": "Alcohol", "price": 35.80, "stock": 50, "emoji": "🧴", "description": "Michael Isopropyl Rubbing Alcohol 70% Green — 180ml. Kills 99.9% of germs.", "badge": "hot"},
    {"id": 15, "name": "Michael Isopropyl Alcohol 70% 470ml", "category": "Alcohol", "price": 70.55, "stock": 24, "emoji": "🧴", "description": "Michael Isopropyl Rubbing Alcohol 70% Green — 470ml value size.", "badge": ""},
    {"id": 16, "name": "Michael Isopropyl Alcohol 40% 180ml", "category": "Alcohol", "price": 28.85, "stock": 50, "emoji": "💧", "description": "Michael Isopropyl Alcologne 40% White — 180ml. Gentle formula with fragrance.", "badge": ""},
    {"id": 17, "name": "Michael Isopropyl Alcohol 40% 470ml", "category": "Alcohol", "price": 52.15, "stock": 24, "emoji": "💧", "description": "Michael Isopropyl Alcologne 40% White — 470ml. Great value.", "badge": ""},
    {"id": 18, "name": "Michael Ethyl Alcohol 70% 90ml", "category": "Alcohol", "price": 20.60, "stock": 72, "emoji": "🟢", "description": "Michael Ethyl Alcohol Green 70% — 90ml. Premium ethyl formula.", "badge": "new"},
    {"id": 19, "name": "Michael Ethyl Alcohol 70% 180ml", "category": "Alcohol", "price": 34.00, "stock": 50, "emoji": "🟢", "description": "Michael Ethyl Alcohol Green 70% — 180ml.", "badge": ""},
    {"id": 20, "name": "Michael Ethyl Alcohol 70% 470ml", "category": "Alcohol", "price": 67.00, "stock": 24, "emoji": "🟢", "description": "Michael Ethyl Alcohol Green 70% — 470ml value size.", "badge": ""},
    {"id": 21, "name": "Michael Ethyl Alcohol 40% 470ml", "category": "Alcohol", "price": 49.50, "stock": 24, "emoji": "⚗️", "description": "Michael Ethyl Alcologne 40% — 470ml. Mild & fragrant formula.", "badge": ""},
    {"id": 22, "name": "Great Moods Body Spray 50ml (Drakkus)", "category": "Body Care", "price": 1998 / 17, "stock": 17, "emoji": "🌺", "description": "Great Moods Body Spray 50ml in Drakkus fragrance. Long-lasting scent.", "badge": "new"},
    {"id": 23, "name": "Great Moods Body Splash 50ml", "category": "Body Care", "price": 33.30, "stock": 34, "emoji": "💫", "description": "Great Moods Body Splash 50ml — Freedom scent. Light & refreshing.", "badge": ""},
    {"id": 24, "name": "Michael Baby Cologne 150ml Pink", "category": "Body Care", "price": 3723 / 20, "stock": 20, "emoji": "🌸", "description": "Michael Baby Cologne 150ml — delicate Pink fragrance. Safe for baby & adults.", "badge": "hot"},
    {"id": 25, "name": "Michael Baby Cologne 150ml Blue", "category": "Body Care", "price": 3723 / 20, "stock": 20, "emoji": "💙", "description": "Michael Baby Cologne 150ml — fresh Blue fragrance. Gentle & long-lasting.", "badge": ""},
    {"id": 26, "name": "Great Love Cotton Buds 60's", "category": "Personal Care", "price": 7.95, "stock": 480, "emoji": "🤍", "description": "Great Love Cotton Buds Resealable Plastic 60's. Soft & absorbent.", "badge": ""},
    {"id": 27, "name": "Great Love Cotton Buds 108's", "category": "Personal Care", "price": 9.80, "stock": 240, "emoji": "🤍", "description": "Great Love Cotton Buds 108's Pack. Economy size.", "badge": ""},
    {"id": 28, "name": "Great Love Cotton Buds 200's", "category": "Personal Care", "price": 17.45, "stock": 240, "emoji": "🤍", "description": "Great Love Cotton Buds 200's Pack. Great value for families.", "badge": "hot"},
    {"id": 29, "name": "Great Love Cotton Buds 300's", "category": "Personal Care", "price": 26.40, "stock": 240, "emoji": "🤍", "description": "Great Love Cotton Buds 300's Pack. Bulk pack for maximum savings.", "badge": ""},
]

ACCOUNTS = [
    {"email": "customer@gv.com", "password": "1234", "role": models.Role.customer, "name": "Jane Dela Cruz", "initials": "JD"},
    {"email": "admin@gv.com", "password": "admin123", "role": models.Role.admin, "name": "Administrator", "initials": "AD"},
]


def seed():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if db.query(models.Product).count() == 0:
            for p in PRODUCTS:
                db.add(models.Product(**p))
            print(f"Seeded {len(PRODUCTS)} products.")
        else:
            print("Products already seeded, skipping.")

        if db.query(models.User).count() == 0:
            for a in ACCOUNTS:
                db.add(models.User(
                    email=a["email"],
                    password_hash=auth.hash_password(a["password"]),
                    name=a["name"],
                    initials=a["initials"],
                    role=a["role"],
                ))
            print(f"Seeded {len(ACCOUNTS)} accounts (customer@gv.com / 1234, admin@gv.com / admin123).")
        else:
            print("Accounts already seeded, skipping.")

        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    seed()