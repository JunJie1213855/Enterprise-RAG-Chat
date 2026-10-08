"""
Chat API routes with full RAG pipeline
"""
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from slowapi import Limiter
from slowapi.util import get_remote_address
from loguru import logger
import json

from app.core.dependencies import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.schemas.chat import (
    ChatRequest,
    ChatResponse,
    SessionListResponse,
    SessionDetailResponse,
    SessionResponse,
    DocumentUploadRequest,
    DocumentResponse,
    UpdateSessionTitleRequest,
    MessageResponse,
)
from app.services.chat_service import ChatService
from app.rag.retriever import RAGRetriever
from app.rag.llm_service import llm_service

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


@router.post("/", response_model=ChatResponse)
@limiter.limit("30/minute")
async def chat(
    request: Request,
    body: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Main chat endpoint with full RAG pipeline:
    1. Get/create session
    2. Retrieve relevant context from vector store
    3. Build augmented prompt
    4. Generate LLM response
    5. Persist message & return
    """
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    if len(body.message) > 10000:
        raise HTTPException(status_code=400, detail="Message too long (max 10,000 chars)")

    chat_service = ChatService(db)
    rag_retriever = RAGRetriever(db)

    # 1. Session
    auto_title = await chat_service.auto_title_from_message(body.message)
    session = await chat_service.get_or_create_session(
        current_user, body.session_id, title=auto_title
    )

    # 2. Retrieve RAG context
    rag_contexts = []
    if body.use_rag and current_user.organization_id:
        rag_contexts = await rag_retriever.retrieve(
            query=body.message,
            organization_id=current_user.organization_id,
        )

    # 3. Build conversation history
    prior_messages = await chat_service.get_session_messages(session.id, limit=20)
    history = [{"role": m.role, "content": m.content} for m in prior_messages]

    # 4. Build augmented prompt
    messages = rag_retriever.build_augmented_prompt(
        user_message=body.message,
        contexts=rag_contexts,
        conversation_history=history,
    )

    # 5. Save user message
    user_msg = await chat_service.save_message(
        session_id=session.id,
        user_id=current_user.id,
        role="user",
        content=body.message,
    )

    # 6. Call LLM
    try:
        response_text, tokens_used = await llm_service.chat(messages)
    except Exception as e:
        logger.error(f"LLM call failed: {e}")
        raise HTTPException(status_code=503, detail="AI service temporarily unavailable")

    # 7. Save assistant message
    context_data = [c.model_dump() for c in rag_contexts]
    assistant_msg = await chat_service.save_message(
        session_id=session.id,
        user_id=None,
        role="assistant",
        content=response_text,
        tokens_used=tokens_used,
        context_used=context_data,
    )

    return ChatResponse(
        message=MessageResponse.model_validate(assistant_msg),
        session_id=session.id,
        session_title=session.title,
        rag_context=rag_contexts,
        total_tokens=tokens_used,
    )


@router.post("/stream")
@limiter.limit("20/minute")
async def chat_stream(
    request: Request,
    body: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Streaming chat endpoint (SSE)."""
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    chat_service = ChatService(db)
    rag_retriever = RAGRetriever(db)

    auto_title = await chat_service.auto_title_from_message(body.message)
    session = await chat_service.get_or_create_session(
        current_user, body.session_id, title=auto_title
    )

    rag_contexts = []
    if body.use_rag and current_user.organization_id:
        rag_contexts = await rag_retriever.retrieve(
            query=body.message,
            organization_id=current_user.organization_id,
        )

    prior_messages = await chat_service.get_session_messages(session.id, limit=20)
    history = [{"role": m.role, "content": m.content} for m in prior_messages]

    messages = rag_retriever.build_augmented_prompt(
        user_message=body.message,
        contexts=rag_contexts,
        conversation_history=history,
    )

    await chat_service.save_message(
        session_id=session.id,
        user_id=current_user.id,
        role="user",
        content=body.message,
    )

    full_response = []

    async def generate():
        try:
            # Send session info first
            yield f"data: {json.dumps({'type': 'session', 'session_id': str(session.id), 'title': session.title})}\n\n"

            async for token in llm_service.stream_chat(messages):
                full_response.append(token)
                yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"

            # Save complete response
            complete = "".join(full_response)
            await chat_service.save_message(
                session_id=session.id,
                user_id=None,
                role="assistant",
                content=complete,
                context_used=[c.model_dump() for c in rag_contexts],
            )

            yield f"data: {json.dumps({'type': 'done', 'session_id': str(session.id)})}\n\n"
        except Exception as e:
            logger.error(f"Stream error: {e}")
            yield f"data: {json.dumps({'type': 'error', 'message': 'Stream failed'})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ------------------------------------------------------------------
# Sessions
# ------------------------------------------------------------------

@router.get("/sessions", response_model=SessionListResponse)
async def list_sessions(
    limit: int = 20,
    offset: int = 0,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List user's chat sessions."""
    chat_service = ChatService(db)
    sessions, total = await chat_service.list_user_sessions(
        current_user.id, limit=min(limit, 100), offset=offset
    )

    session_responses = []
    for s in sessions:
        count = await chat_service.get_session_message_count(s.id)
        session_responses.append(
            SessionResponse(
                id=s.id,
                title=s.title,
                is_active=s.is_active,
                message_count=count,
                created_at=s.created_at,
                updated_at=s.updated_at,
            )
        )

    return SessionListResponse(sessions=session_responses, total=total)


@router.get("/sessions/{session_id}", response_model=SessionDetailResponse)
async def get_session(
    session_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get session details with messages."""
    chat_service = ChatService(db)
    session = await chat_service.get_session_by_id(session_id, current_user.id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.patch("/sessions/{session_id}")
async def update_session(
    session_id: UUID,
    body: UpdateSessionTitleRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update session title."""
    chat_service = ChatService(db)
    session = await chat_service.update_session_title(session_id, current_user.id, body.title)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"message": "Session updated", "title": session.title}


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete (soft-delete) a chat session."""
    chat_service = ChatService(db)
    deleted = await chat_service.delete_session(session_id, current_user.id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"message": "Session deleted"}


# ------------------------------------------------------------------
# Documents / Knowledge Base
# ------------------------------------------------------------------

@router.post("/documents", response_model=DocumentResponse, status_code=201)
async def upload_document(
    body: DocumentUploadRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload a document to the knowledge base and index it."""
    from app.models.chat import Document

    if not current_user.organization_id:
        raise HTTPException(status_code=400, detail="User has no organization")

    doc = Document(
        organization_id=current_user.organization_id,
        title=body.title,
        content=body.content,
        source=body.source,
        doc_type=body.doc_type,
    )
    db.add(doc)
    await db.flush()
    await db.refresh(doc)

    rag = RAGRetriever(db)
    chunk_count = await rag.index_document(doc)

    logger.info(f"Document '{doc.title}' uploaded and indexed with {chunk_count} chunks")
    return doc


@router.get("/documents", response_model=list[DocumentResponse])
async def list_documents(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List organization's knowledge base documents."""
    from sqlalchemy import select
    from app.models.chat import Document

    if not current_user.organization_id:
        return []

    result = await db.execute(
        select(Document).where(
            Document.organization_id == current_user.organization_id,
            Document.is_active == True,
        )
    )
    return list(result.scalars().all())


@router.delete("/documents/{doc_id}")
async def delete_document(
    doc_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Soft-delete a document from the knowledge base."""
    from sqlalchemy import select
    from app.models.chat import Document

    result = await db.execute(
        select(Document).where(
            Document.id == doc_id,
            Document.organization_id == current_user.organization_id,
        )
    )
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    doc.is_active = False
    return {"message": "Document deleted"}
