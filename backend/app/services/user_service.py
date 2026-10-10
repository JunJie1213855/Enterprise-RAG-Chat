"""
User service - CRUD operations for users and organizations
"""
import uuid
import re
from typing import Optional
from uuid import UUID

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models.user import User, Organization
from app.core.security import get_password_hash, verify_password
from app.schemas.auth import UserRegisterRequest

# 用户服务
class UserService:
    def __init__(self, db: AsyncSession):
        self.db = db
    # 从 pgsql 利用条件语句 和 id 获取用户信息
    async def get_user_by_id(self, user_id: UUID) -> Optional[User]:
        result = await self.db.execute(select(User).where(User.id == user_id))
        return result.scalar_one_or_none()
    # 从 pgsql 利用条件语句 和 email 获取用户信息
    async def get_user_by_email(self, email: str) -> Optional[User]:
        result = await self.db.execute(
            select(User).where(User.email == email.lower())
        )
        return result.scalar_one_or_none()

    # 创建用户 user
    async def create_user(
        self,
        request: UserRegisterRequest,
        organization_id: Optional[UUID] = None,
        role: str = "member",
    ) -> User:
        # 保存密码哈希值
        hashed = get_password_hash(request.password)
        # 用户数据包括：邮箱、用户名、哈希密码、全称、组织id、校色、是否活跃、是否验证
        user = User(
            email=request.email.lower(),
            username=request.username.lower(),
            hashed_password=hashed,
            full_name=request.full_name,
            organization_id=organization_id,
            role=role,
            is_active=True,
            is_verified=False,
        )
        # 添加
        self.db.add(user)
        # 刷新数据库
        await self.db.flush()
        await self.db.refresh(user)
        logger.info(f"Created user: {user.email}")
        return user
    # 用户认证
    async def authenticate_user(self, email: str, password: str) -> Optional[User]:
        user = await self.get_user_by_email(email)
        if not user:
            return None
        if not verify_password(password, user.hashed_password):
            return None
        return user
    # 获取
    async def get_or_create_organization(
        self, name: Optional[str] = None
    ) -> Organization:
        """Get default org or create new one."""
        if name:
            # 正则表达式获取组织名
            slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
            # Check uniqueness
            existing = await self.db.execute(
                select(Organization).where(Organization.slug == slug)
            )
            if existing.scalar_one_or_none():
                slug = f"{slug}-{str(uuid.uuid4())[:8]}"

            org = Organization(name=name, slug=slug)
            self.db.add(org)
            await self.db.flush()
            await self.db.refresh(org)
            return org
        else:
            # Return default org
            result = await self.db.execute(
                select(Organization).where(Organization.slug == "default")
            )
            org = result.scalar_one_or_none()
            if not org:
                org = Organization(name="Default", slug="default")
                self.db.add(org)
                await self.db.flush()
                await self.db.refresh(org)
            return org

    async def update_last_login(self, user: User) -> None:
        from datetime import datetime
        user.last_login = datetime.utcnow()
        await self.db.flush()

    # 更换密码
    async def change_password(
        self, user: User, current_password: str, new_password: str
    ) -> bool:
        # 密码验证
        if not verify_password(current_password, user.hashed_password):
            return False
        # 更换密码
        user.hashed_password = get_password_hash(new_password)
        # 刷新
        await self.db.flush()
        return True
    # 依靠用户名和组织id获取数据
    async def get_organization_users(self, org_id: UUID) -> list[User]:
        result = await self.db.execute(
            select(User).where(User.organization_id == org_id)
        )
        return list(result.scalars().all())
    # 活跃性设置
    async def deactivate_user(self, user_id: UUID) -> Optional[User]:
        user = await self.get_user_by_id(user_id)
        if user:
            user.is_active = False
            await self.db.flush()
        return user
