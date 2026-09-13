from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas, auth
from ..database import get_db

router = APIRouter(prefix="/wishlist", tags=["wishlist"])


@router.get("", response_model=List[schemas.ProductOut])
def get_wishlist(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    items = db.query(models.WishlistItem).filter(models.WishlistItem.user_id == current_user.id).all()
    product_ids = [i.product_id for i in items]
    if not product_ids:
        return []
    products = db.query(models.Product).filter(models.Product.id.in_(product_ids)).all()
    return products


@router.post("/{product_id}")
def toggle_wishlist(
    product_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    product = db.query(models.Product).filter(models.Product.id == product_id).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    existing = db.query(models.WishlistItem).filter(
        models.WishlistItem.user_id == current_user.id,
        models.WishlistItem.product_id == product_id,
    ).first()

    if existing:
        db.delete(existing)
        db.commit()
        return {"in_wishlist": False}

    db.add(models.WishlistItem(user_id=current_user.id, product_id=product_id))
    db.commit()
    return {"in_wishlist": True}
