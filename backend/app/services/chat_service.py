"""
Chat service - manages chat sessions and messages
"""
from typing import Optional, List
from uuid import UUID

from sqlalchemy import select, func, desc
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.models.chat import ChatSession, Message
from app.models.user import User


class ChatService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_or_create_session(
        self,
        user: User,
        session_id: Optional[UUID] = None,
        title: str = "New Chat",
    ) -> ChatSession:
        if session_id:
            result = await self.db.execute(
                select(ChatSession).where(
                    ChatSession.id == session_id,
                    ChatSession.user_id == user.id,
                    ChatSession.is_active == True,
                )
            )
            session = result.scalar_one_or_none()
            if session:
                return session

        # Create new session
        session = ChatSession(
            user_id=user.id,
            organization_id=user.organization_id,
            title=title,
        )
        self.db.add(session)
        await self.db.flush()
        await self.db.refresh(session)
        logger.info(f"Created chat session: {session.id} for user: {user.email}")
        return session

    async def get_session_by_id(
        self, session_id: UUID, user_id: UUID
    ) -> Optional[ChatSession]:
        result = await self.db.execute(
            select(ChatSession)
            .options(selectinload(ChatSession.messages))
            .where(
                ChatSession.id == session_id,
                ChatSession.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()

    async def list_user_sessions(
        self, user_id: UUID, limit: int = 20, offset: int = 0
    ) -> tuple[List[ChatSession], int]:
        # Count
        count_result = await self.db.execute(
            select(func.count(ChatSession.id)).where(
                ChatSession.user_id == user_id,
                ChatSession.is_active == True,
            )
        )
        total = count_result.scalar()

        # Fetch
        result = await self.db.execute(
            select(ChatSession)
            .where(
                ChatSession.user_id == user_id,
                ChatSession.is_active == True,
            )
            .order_by(desc(ChatSession.updated_at))
            .limit(limit)
            .offset(offset)
        )
        sessions = list(result.scalars().all())
        return sessions, total

    async def save_message(
        self,
        session_id: UUID,
        user_id: Optional[UUID],
        role: str,
        content: str,
        tokens_used: int = 0,
        context_used: list = None,
        metadata: dict = None,
    ) -> Message:
        message = Message(
            session_id=session_id,
            user_id=user_id,
            role=role,
            content=content,
            tokens_used=tokens_used,
            context_used=context_used or [],
            metadata_=metadata or {},
        )
        self.db.add(message)
        await self.db.flush()
        await self.db.refresh(message)
        return message

    async def get_session_messages(
        self, session_id: UUID, limit: int = 50
    ) -> List[Message]:
        result = await self.db.execute(
            select(Message)
            .where(Message.session_id == session_id)
            .order_by(Message.created_at)
            .limit(limit)
        )
        return list(result.scalars().all())

    async def get_session_message_count(self, session_id: UUID) -> int:
        result = await self.db.execute(
            select(func.count(Message.id)).where(Message.session_id == session_id)
        )
        return result.scalar() or 0

    async def update_session_title(
        self, session_id: UUID, user_id: UUID, title: str
    ) -> Optional[ChatSession]:
        result = await self.db.execute(
            select(ChatSession).where(
                ChatSession.id == session_id,
                ChatSession.user_id == user_id,
            )
        )
        session = result.scalar_one_or_none()
        if session:
            session.title = title[:500]
            await self.db.flush()
        return session

    async def delete_session(
        self, session_id: UUID, user_id: UUID
    ) -> bool:
        result = await self.db.execute(
            select(ChatSession).where(
                ChatSession.id == session_id,
                ChatSession.user_id == user_id,
            )
        )
        session = result.scalar_one_or_none()
        if session:
            session.is_active = False
            await self.db.flush()
            return True
        return False

    async def auto_title_from_message(self, message: str) -> str:
        """Generate a short title from first message."""
        words = message.split()[:8]
        title = " ".join(words)
        if len(message.split()) > 8:
            title += "..."
        return title[:100]
