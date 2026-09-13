from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas, auth
from ..database import get_db

router = APIRouter(prefix="/products", tags=["products"])


def _to_out(db: Session, p: models.Product) -> schemas.ProductOut:
    avg, count = db.query(
        func.avg(models.Rating.stars), func.count(models.Rating.id)
    ).filter(models.Rating.product_id == p.id).one()
    out = schemas.ProductOut.model_validate(p)
    out.avg_rating = round(float(avg), 1) if avg else 0.0
    out.rating_count = count or 0
    return out


@router.get("", response_model=List[schemas.ProductOut])
def list_products(
    category: Optional[str] = None,
    q: Optional[str] = None,
    max_price: Optional[float] = None,
    min_rating: Optional[float] = None,
    db: Session = Depends(get_db),
):
    query = db.query(models.Product)
    if category and category != "All":
        query = query.filter(models.Product.category == category)
    if q:
        query = query.filter(models.Product.name.ilike(f"%{q}%"))
    if max_price is not None:
        query = query.filter(models.Product.price <= max_price)
    query = query.order_by(models.Product.id)
    products = query.all()
    results = [_to_out(db, p) for p in products]
    if min_rating:
        results = [r for r in results if r.avg_rating >= min_rating]
    return results


@router.get("/{product_id}", response_model=schemas.ProductOut)
def get_product(product_id: int, db: Session = Depends(get_db)):
    p = db.query(models.Product).filter(models.Product.id == product_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Product not found")
    return _to_out(db, p)


@router.post("", response_model=schemas.ProductOut)
def create_product(
    payload: schemas.ProductCreate,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    p = models.Product(**payload.model_dump())
    db.add(p)
    db.commit()
    db.refresh(p)
    return _to_out(db, p)


@router.put("/{product_id}", response_model=schemas.ProductOut)
def update_product(
    product_id: int,
    payload: schemas.ProductUpdate,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    p = db.query(models.Product).filter(models.Product.id == product_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Product not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(p, field, value)
    db.commit()
    db.refresh(p)
    return _to_out(db, p)


@router.delete("/{product_id}")
def delete_product(
    product_id: int,
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    p = db.query(models.Product).filter(models.Product.id == product_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Product not found")
    db.delete(p)
    db.commit()
    return {"detail": "Product deleted"}


@router.post("/{product_id}/rate", response_model=schemas.RatingOut)
def rate_product(
    product_id: int,
    payload: schemas.RatingCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    if not (1 <= payload.stars <= 5):
        raise HTTPException(status_code=400, detail="Stars must be between 1 and 5")

    product = db.query(models.Product).filter(models.Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    rating = (
        db.query(models.Rating)
        .filter(models.Rating.product_id == product_id, models.Rating.user_id == current_user.id)
        .first()
    )
    if rating:
        rating.stars = payload.stars
    else:
        rating = models.Rating(product_id=product_id, user_id=current_user.id, stars=payload.stars)
        db.add(rating)
    db.commit()

    avg, count = db.query(
        func.avg(models.Rating.stars), func.count(models.Rating.id)
    ).filter(models.Rating.product_id == product_id).one()
    return schemas.RatingOut(avg=round(float(avg), 1), count=count, user_rating=payload.stars)