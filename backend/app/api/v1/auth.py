"""
Authentication API routes
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession
from slowapi import Limiter
from slowapi.util import get_remote_address
from loguru import logger

from app.core.security import create_access_token, create_refresh_token, decode_token
from app.core.dependencies import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.schemas.auth import (
    UserRegisterRequest,
    UserLoginRequest,
    TokenResponse,
    RefreshTokenRequest,
    UserResponse,
    ChangePasswordRequest,
)
from app.services.user_service import UserService

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("10/hour")
async def register(
    request: Request,
    body: UserRegisterRequest,
    db: AsyncSession = Depends(get_db),
):
    """Register a new user."""
    user_service = UserService(db)

    # Check duplicate email
    existing = await user_service.get_user_by_email(body.email)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        )

    # Get or create organization
    org = await user_service.get_or_create_organization(body.organization_name)

    # First user in org becomes admin
    org_users = await user_service.get_organization_users(org.id)
    role = "admin" if not org_users else "member"

    user = await user_service.create_user(body, organization_id=org.id, role=role)
    logger.info(f"New user registered: {user.email} in org: {org.slug}")
    return user


@router.post("/login", response_model=TokenResponse)
@limiter.limit("20/hour")
async def login(
    request: Request,
    body: UserLoginRequest,
    db: AsyncSession = Depends(get_db),
):
    """Authenticate and return JWT tokens."""
    user_service = UserService(db)
    user = await user_service.authenticate_user(body.email, body.password)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is deactivated",
        )

    await user_service.update_last_login(user)

    token_data = {
        "sub": str(user.id),
        "email": user.email,
        "role": user.role,
        "org_id": str(user.organization_id) if user.organization_id else None,
    }

    from app.core.config import settings
    return TokenResponse(
        access_token=create_access_token(token_data),
        refresh_token=create_refresh_token(token_data),
        expires_in=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(body: RefreshTokenRequest):
    """Refresh access token using refresh token."""
    payload = decode_token(body.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )

    token_data = {
        "sub": payload["sub"],
        "email": payload.get("email"),
        "role": payload.get("role"),
        "org_id": payload.get("org_id"),
    }
    from app.core.config import settings
    return TokenResponse(
        access_token=create_access_token(token_data),
        refresh_token=create_refresh_token(token_data),
        expires_in=settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: User = Depends(get_current_user)):
    """Get current user profile."""
    return current_user


@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Change user password."""
    user_service = UserService(db)
    success = await user_service.change_password(
        current_user, body.current_password, body.new_password
    )
    if not success:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )
    return {"message": "Password changed successfully"}


@router.post("/logout")
async def logout(current_user: User = Depends(get_current_user)):
    """Logout (client should discard tokens)."""
    logger.info(f"User logged out: {current_user.email}")
    return {"message": "Logged out successfully"}
