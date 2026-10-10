"""
Admin API routes - user management, org stats, system info
"""
from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_admin, get_current_user
from app.db.session import get_db
from app.models.user import User, Organization
from app.models.chat import ChatSession, Message, Document
from app.schemas.auth import UserResponse, OrganizationResponse
from app.services.user_service import UserService

router = APIRouter()

# 当前状态
@router.get("/stats")
async def get_stats(
    current_user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Get organization statistics (admin only)."""
    org_id = current_user.organization_id

    user_count = await db.execute(
        select(func.count(User.id)).where(User.organization_id == org_id)
    )
    session_count = await db.execute(
        select(func.count(ChatSession.id)).where(ChatSession.organization_id == org_id)
    )
    message_count = await db.execute(
        select(func.count(Message.id))
        .join(ChatSession, ChatSession.id == Message.session_id)
        .where(ChatSession.organization_id == org_id)
    )
    doc_count = await db.execute(
        select(func.count(Document.id)).where(
            Document.organization_id == org_id,
            Document.is_active == True,
        )
    )

    return {
        "organization_id": str(org_id),
        "total_users": user_count.scalar(),
        "total_sessions": session_count.scalar(),
        "total_messages": message_count.scalar(),
        "total_documents": doc_count.scalar(),
    }


@router.get("/users", response_model=List[UserResponse])
async def list_users(
    current_user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """List all users in the organization."""
    result = await db.execute(
        select(User)
        .where(User.organization_id == current_user.organization_id)
        .order_by(User.created_at)
    )
    return list(result.scalars().all())


@router.patch("/users/{user_id}/role")
async def update_user_role(
    user_id: UUID,
    role: str,
    current_user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Update a user's role."""
    valid_roles = {"admin", "member", "viewer"}
    if role not in valid_roles:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {valid_roles}")

    result = await db.execute(
        select(User).where(
            User.id == user_id,
            User.organization_id == current_user.organization_id,
        )
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.role = role
    return {"message": f"User role updated to {role}"}


@router.delete("/users/{user_id}")
async def deactivate_user(
    user_id: UUID,
    current_user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Deactivate a user account."""
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot deactivate your own account")

    user_service = UserService(db)
    user = await user_service.deactivate_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return {"message": "User deactivated"}


@router.get("/organization", response_model=OrganizationResponse)
async def get_organization(
    current_user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Get organization details."""
    result = await db.execute(
        select(Organization).where(Organization.id == current_user.organization_id)
    )
    org = result.scalar_one_or_none()
    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")
    return org
