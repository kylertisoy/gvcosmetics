from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, EmailStr, ConfigDict


# ─────────── AUTH / USERS ───────────
class UserCreate(BaseModel):
    email: EmailStr
    password: str
    name: str


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str
    name: str
    initials: Optional[str] = None
    role: str
    loyalty_points: int
    approval_status: str = "approved"
    email_verified: bool = True
    created_at: Optional[datetime] = None


class RegisterOut(BaseModel):
    detail: str
    approval_status: str


class VerifyEmailIn(BaseModel):
    email: EmailStr
    code: str


class ResendCodeIn(BaseModel):
    email: EmailStr


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


# ─────────── PRODUCTS ───────────
class ProductBase(BaseModel):
    name: str
    category: str
    price: float
    stock: int = 0
    emoji: str = "💄"
    description: str = ""
    badge: str = ""
    image_url: Optional[str] = None


class ProductCreate(ProductBase):
    pass


class ProductUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    price: Optional[float] = None
    stock: Optional[int] = None
    emoji: Optional[str] = None
    description: Optional[str] = None
    badge: Optional[str] = None
    image_url: Optional[str] = None


class ProductOut(ProductBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    avg_rating: float = 0.0
    rating_count: int = 0


# ─────────── ADDRESSES ───────────
class AddressBase(BaseModel):
    name: str
    phone: str
    street: str
    city: str
    province: str
    zip: str
    label: str = "Home"
    is_default: bool = False


class AddressCreate(AddressBase):
    pass


class AddressOut(AddressBase):
    model_config = ConfigDict(from_attributes=True)
    id: int


# ─────────── ORDERS ───────────
class OrderItemIn(BaseModel):
    product_id: int
    quantity: int


class OrderCreate(BaseModel):
    items: List[OrderItemIn]
    shipping_name: str
    shipping_address: str
    payment_method: str = "cod"  # 'cod' | 'gcash' | 'card' | 'maya'


class OrderItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    product_id: Optional[int]
    product_name: str
    unit_price: float
    quantity: int


class OrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    order_number: str
    total: float
    status: str
    shipping_name: Optional[str]
    shipping_address: Optional[str]
    tracking_number: Optional[str]
    customer_name: Optional[str] = None
    created_at: datetime
    items: List[OrderItemOut] = []
    payment_method: str = "cod"
    payment_status: str = "unpaid"
    cancel_reason: Optional[str] = None


class OrderStatusUpdate(BaseModel):
    status: str


class OrderCancelIn(BaseModel):
    reason: str


# ─────────── WISHLIST ───────────
class WishlistOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    product_id: int


# ─────────── RATINGS ───────────
class RatingCreate(BaseModel):
    stars: int


class RatingOut(BaseModel):
    avg: float
    count: int
    user_rating: int = 0


# ─────────── NOTIFICATIONS ───────────
class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    title: str
    message: str
    type: str
    read: bool
    created_at: datetime


# ─────────── CUSTOMERS / ANALYTICS ───────────
class CustomerOut(BaseModel):
    name: str
    email: str
    orders: int
    total: float
    seg: str


class DashboardStats(BaseModel):
    total_revenue: float
    total_orders: int
    pending_orders: int
    total_customers: int
    status_breakdown: dict


class AnalyticsOut(BaseModel):
    revenue_by_status: dict
    customer_segments: dict
    top_products: List[dict]