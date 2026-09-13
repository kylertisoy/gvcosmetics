from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas, auth
from ..database import get_db

router = APIRouter(prefix="/addresses", tags=["addresses"])


@router.get("", response_model=List[schemas.AddressOut])
def list_addresses(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    return db.query(models.Address).filter(models.Address.user_id == current_user.id).all()


@router.post("", response_model=schemas.AddressOut)
def add_address(
    payload: schemas.AddressCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    if payload.is_default:
        db.query(models.Address).filter(models.Address.user_id == current_user.id).update(
            {"is_default": False}
        )
    addr = models.Address(user_id=current_user.id, **payload.model_dump())
    db.add(addr)
    db.commit()
    db.refresh(addr)
    return addr


@router.delete("/{address_id}")
def delete_address(
    address_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    addr = db.query(models.Address).filter(
        models.Address.id == address_id, models.Address.user_id == current_user.id
    ).first()
    if not addr:
        raise HTTPException(status_code=404, detail="Address not found")
    db.delete(addr)
    db.commit()
    return {"detail": "Address deleted"}


@router.patch("/{address_id}/default", response_model=schemas.AddressOut)
def set_default_address(
    address_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    addr = db.query(models.Address).filter(
        models.Address.id == address_id, models.Address.user_id == current_user.id
    ).first()
    if not addr:
        raise HTTPException(status_code=404, detail="Address not found")
    db.query(models.Address).filter(models.Address.user_id == current_user.id).update(
        {"is_default": False}
    )
    addr.is_default = True
    db.commit()
    db.refresh(addr)
    return addr
