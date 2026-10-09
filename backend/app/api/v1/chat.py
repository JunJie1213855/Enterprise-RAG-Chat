"""
Chat API routes with full RAG pipeline
"""
from typing import Optional
from uuid import UUID

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from slowapi import Limiter
from slowapi.util import get_remote_address
from loguru import logger
import json

import asyncio

from app.core.config import settings
from app.core.dependencies import get_current_user
from app.db.session import AsyncSessionLocal, get_db
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
from app.rag.factory import get_retriever
from app.rag.ingest import index_document
from app.rag.llm_service import llm_service
from app.rag.parsers import (
    DocumentParseError,
    extract_text_from_bytes,
    is_supported,
    supported_extensions,
)

# API 路由
router = APIRouter()
# 限制器
limiter = Limiter(key_func=get_remote_address)

# Idle interval after which the SSE endpoint emits a keep-alive comment frame.
SSE_HEARTBEAT_SECONDS = settings.SSE_HEARTBEAT_SECONDS


# 编码
def _sse(payload: dict) -> str:
    """Encode one SSE data frame."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

# 流式协议 + 心跳机制
async def _stream_with_heartbeat(source, interval: float = SSE_HEARTBEAT_SECONDS):
    """Yield ``(kind, value)`` tuples from ``source``, emitting heartbeats.

    A producer task feeds a queue so the timeout only ever cancels
    ``queue.get()`` — never the underlying LLM stream, which would corrupt it.
    """
    # 异步队列
    queue: asyncio.Queue = asyncio.Queue()

    async def produce():
        try:
            async for token in source:
                await queue.put(("token", token))
        except Exception as e:  # noqa: BLE001 - surfaced to the caller as an event
            await queue.put(("error", str(e)))
        finally:
            await queue.put(("eof", None))
    # 执行生产任务
    task = asyncio.create_task(produce())
    try:
        while True:
            try:
                kind, value = await asyncio.wait_for(queue.get(), timeout=interval)
            except asyncio.TimeoutError:
                yield ("heartbeat", None)
                continue
            yield (kind, value)
            if kind == "eof":
                break
    finally:
        if not task.done():
            task.cancel()


async def _persist_assistant_message(session_id, content: str, rag_contexts) -> None:
    """Store the assistant reply using a fresh DB session.

    The request-scoped session may already be torn down when the client
    disconnects mid-stream, so cleanup must not rely on it.
    """
    if not content.strip():
        return
    try:
        async with AsyncSessionLocal() as save_db:
            await ChatService(save_db).save_message(
                session_id=session_id,
                user_id=None,
                role="assistant",
                content=content,
                context_used=[c.model_dump() for c in rag_contexts],
            )
            await save_db.commit()
    except Exception as e:  # noqa: BLE001 - never let cleanup break the stream
        logger.error(f"Failed to persist streamed reply for session {session_id}: {e}")


# ！！！ 核心问答 API，用户输入提示词，RAG处理 + 传输
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
    rag_retriever = get_retriever(db)

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
        response_text, tokens_used = await llm_service.chat(messages) # 调用 API
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


# 流式问答
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
    rag_retriever = get_retriever(db)

    auto_title = await chat_service.auto_title_from_message(body.message)
    session = await chat_service.get_or_create_session(
        current_user, body.session_id, title=auto_title
    )

    await chat_service.save_message(
        session_id=session.id,
        user_id=current_user.id,
        role="user",
        content=body.message,
    )
    # Commit now: if the client disconnects mid-stream the request-scoped
    # session may never commit, which would drop the question and leave an
    # orphaned answer behind.
    await db.commit()

    session_id = session.id
    session_title = session.title
    org_id = current_user.organization_id

    async def generate():
        # Retrieval and prompt building run *inside* the stream so the client
        # gets a frame straight away instead of waiting on an embedding call.
        full_response: list[str] = []
        rag_contexts: list = []
        try:
            yield _sse({
                "type": "session",
                "session_id": str(session_id),
                "title": session_title,
            })

            if body.use_rag and org_id:
                yield _sse({"type": "status", "stage": "retrieving"})
                rag_contexts = await rag_retriever.retrieve(
                    query=body.message,
                    organization_id=org_id,
                )
                yield _sse({
                    "type": "context",
                    "contexts": [c.model_dump() for c in rag_contexts],
                })

            prior_messages = await chat_service.get_session_messages(session_id, limit=20)
            history = [{"role": m.role, "content": m.content} for m in prior_messages]

            messages = rag_retriever.build_augmented_prompt(
                user_message=body.message,
                contexts=rag_contexts,
                conversation_history=history,
            )

            yield _sse({"type": "status", "stage": "generating"})

            async for kind, value in _stream_with_heartbeat(
                llm_service.stream_chat(messages)
            ):
                if kind == "heartbeat":
                    yield ": ping\n\n"
                elif kind == "token":
                    full_response.append(value)
                    yield _sse({"type": "token", "content": value})
                elif kind == "error":
                    raise RuntimeError(value)

            yield _sse({"type": "done", "session_id": str(session_id)})
        except asyncio.CancelledError:
            # Client disconnected — keep whatever was generated (see finally).
            raise
        except Exception as e:  # noqa: BLE001
            logger.error(f"Stream error for session {session_id}: {e}")
            yield _sse({"type": "error", "message": "Stream failed"})
        finally:
            # Runs on normal completion, error, and client disconnect alike, so
            # a stopped generation is still saved instead of vanishing.
            # It must be shielded: a disconnect cancels this task, and a bare
            # await here would be cancelled too — silently losing the reply.
            if full_response:
                pending = asyncio.create_task(
                    _persist_assistant_message(
                        session_id, "".join(full_response), rag_contexts
                    )
                )
                try:
                    await asyncio.shield(pending)
                except asyncio.CancelledError:
                    # Client is gone; the write finishes in the background.
                    pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ------------------------------------------------------------------
# Sessions 获取所有 session，并且列出来
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

# 获取 session_id 对应的 session 信息
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
    background_tasks: BackgroundTasks,
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

    chunk_count = await index_document(doc, db, background=background_tasks)

    logger.info(f"Document '{doc.title}' uploaded and indexed with {chunk_count} chunks")
    return doc


@router.post("/documents/upload", response_model=DocumentResponse, status_code=201)
async def upload_document_file(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload a pdf/docx/md/txt file, extract its text and index it.

    Text extraction covers text-based documents only — scanned/image-only
    PDFs require OCR and will be rejected with a clear message.
    """
    from app.models.chat import Document

    if not current_user.organization_id:
        raise HTTPException(status_code=400, detail="User has no organization")

    filename = file.filename or ""
    if not is_supported(filename):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unsupported file type '{filename}'. "
                f"Supported: {', '.join(supported_extensions())}"
            ),
        )

    max_bytes = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
    data = await file.read()
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds the {settings.MAX_UPLOAD_SIZE_MB} MB upload limit",
        )

    try:
        content = extract_text_from_bytes(filename, data)
    except DocumentParseError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    doc = Document(
        organization_id=current_user.organization_id,
        title=title or file.filename.rsplit(".", 1)[0],
        content=content,
        source=filename,
        doc_type=(file.filename.rsplit(".", 1)[-1].lower() if "." in filename else "text"),
    )
    db.add(doc)
    await db.flush()
    await db.refresh(doc)

    chunk_count = await index_document(doc, db, background=background_tasks)

    logger.info(
        f"Uploaded '{doc.title}' ({filename}) -> {len(content)} chars, "
        f"{chunk_count} chunk(s)"
    )
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
