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
import os

import asyncio

from app.core import metrics
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


def _reject_if_ingest_backlogged() -> None:
    """入库背压：图谱队列过深时拒绝新上传。

    不做这个『快速失败』，请求会一路走到后台任务队列里堆积 —— 每个任务都
    持着一份文档全文等 LightRAG 的信号量，这是大批量灌库时内存被吃光的主因
    （详见 app/core/metrics.py 的说明）。
    """
    from app.rag.ingest import pending_graph_tasks

    pending = len(pending_graph_tasks())
    if pending >= settings.MAX_PENDING_GRAPH_TASKS:
        logger.warning(f"Ingest backlogged: {pending} graph jobs queued; rejecting upload")
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"Knowledge base is busy — {pending} documents are still being "
                f"indexed. Retry once the graph queue drains "
                f"(check /api/v1/metrics → graph_queue.pending)."
            ),
        )


async def _graph_processing_statuses(organization_id, docs: list) -> dict:
    """Map document id -> LightRAG pipeline stage.

    Matches on the document id first. That misses duplicates: LightRAG keys
    ingestion on ``file_path``, so when the same file is imported twice the
    second import is de-duplicated and never gets a status row of its own. The
    fallback is therefore the source basename, which is how LightRAG records
    ``file_path``.

    Best-effort — if the graph is unavailable the list endpoint still works, it
    just reports no statuses.
    """
    if not docs:
        return {}
    try:
        from lightrag.base import DocStatus

        from app.rag.lightrag_retriever import get_engine

        rag = await get_engine(organization_id)
        # One sweep of the status store, keyed two ways.
        by_id = await rag.doc_status.get_docs_by_statuses(list(DocStatus))
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Could not read graph processing statuses: {e}")
        return {}

    # LightRAG records a re-submission of an already-indexed file_path as a
    # `dup-<hash>` row with status `failed` — "rejected as duplicate", not a
    # real failure. Keying the fallback on those would label perfectly healthy
    # documents as failed, so a real row always wins over a duplicate marker.
    candidates: dict = {}
    for doc_id, row in (by_id or {}).items():
        data = row if isinstance(row, dict) else getattr(row, "__dict__", {})
        path = data.get("file_path")
        if path:
            candidates.setdefault(path, []).append(
                (str(doc_id).startswith("dup-"), data.get("status"))
            )

    by_path = {}
    for path, entries in candidates.items():
        entries.sort(key=lambda e: e[0])  # real rows (False) before dup markers
        by_path[path] = entries[0][1]

    out = {}
    for doc in docs:
        key = str(doc.id)
        status = None

        row = (by_id or {}).get(key)
        if row is not None:
            data = row if isinstance(row, dict) else getattr(row, "__dict__", {})
            status = data.get("status")

        if status is None and doc.source:
            # LightRAG stores a basename, our source may be a full path.
            status = by_path.get(os.path.basename(doc.source))

        if status is not None:
            out[key] = getattr(status, "value", status)
    return out


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
        metrics.sse_opened()
        aborted = False
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
            aborted = True
            raise
        except Exception as e:  # noqa: BLE001
            logger.error(f"Stream error for session {session_id}: {e}")
            yield _sse({"type": "error", "message": "Stream failed"})
        finally:
            # 活跃流计数在这里减一 —— 正常结束、报错、客户端断开都会走到
            metrics.sse_closed(aborted)
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

    _reject_if_ingest_backlogged()

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

# 文档上传 API
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

    _reject_if_ingest_backlogged()

    filename = file.filename or ""
    if not is_supported(filename): # 是否支持该文档格式的解析
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unsupported file type '{filename}'. "
                f"Supported: {', '.join(supported_extensions())}"
            ),
        )

    max_bytes = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
    data = await file.read() # 读取数据
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds the {settings.MAX_UPLOAD_SIZE_MB} MB upload limit",
        )

    try:
        content = extract_text_from_bytes(filename, data) # 提取内容
    except DocumentParseError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    # 文档对象生成
    doc = Document(
        organization_id=current_user.organization_id,
        title=title or file.filename.rsplit(".", 1)[0],
        content=content,
        source=filename,
        doc_type=(file.filename.rsplit(".", 1)[-1].lower() if "." in filename else "text"),
    )
    # 数据库更新
    db.add(doc)
    await db.flush()
    await db.refresh(doc)
    # 文档切块
    chunk_count = await index_document(doc, db, background=background_tasks)

    logger.info(
        f"Uploaded '{doc.title}' ({filename}) -> {len(content)} chars, "
        f"{chunk_count} chunk(s)"
    )
    return doc

# 文档查看
@router.get("/documents", response_model=list[DocumentResponse])
async def list_documents(
    include_inactive: bool = False,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List organization's knowledge base documents.

    ``include_inactive=true`` also returns soft-deleted documents. The UI needs
    them: a soft-deleted document silently drops out of retrieval, so without
    showing it the user sees an answer quietly stop working and has no way to
    tell why or to undo it.
    """
    from sqlalchemy import select
    from app.models.chat import Document

    if not current_user.organization_id:
        return []

    stmt = select(Document).where(
        Document.organization_id == current_user.organization_id,
    )
    if not include_inactive:
        stmt = stmt.where(Document.is_active.is_(True))

    result = await db.execute(stmt.order_by(Document.is_active.desc(), Document.created_at.desc()))
    docs = list(result.scalars().all())
    if not docs:
        return []

    # Annotate with the graph pipeline stage. One batched lookup rather than a
    # call per document; documents that never reached the graph stay None.
    statuses = await _graph_processing_statuses(current_user.organization_id, docs)

    return [
        DocumentResponse(
            id=doc.id,
            title=doc.title,
            source=doc.source,
            doc_type=doc.doc_type,
            is_active=doc.is_active,
            created_at=doc.created_at,
            processing_status=statuses.get(str(doc.id)),
        )
        for doc in docs
    ]


@router.post("/documents/{doc_id}/restore", response_model=DocumentResponse)
async def restore_document(
    doc_id: UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Undo a soft delete.

    The vector store only needs the flag flipped back, but the knowledge graph
    may already have dropped the document (its cleanup runs in the background
    after a delete), so we re-queue graph indexing to make the document
    reachable from both paths again.
    """
    from sqlalchemy import select
    from app.models.chat import Document
    from app.rag.ingest import DocumentSnapshot, mirror_to_graph

    result = await db.execute(
        select(Document).where(
            Document.id == doc_id,
            Document.organization_id == current_user.organization_id,
        )
    )
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    doc.is_active = True
    await db.commit()
    await db.refresh(doc)

    # Re-adding is idempotent — LightRAG skips a document it already has — so
    # this is safe even when the graph never lost it.
    snapshot = DocumentSnapshot.of(doc)
    background_tasks.add_task(mirror_to_graph, snapshot)

    logger.info(f"Restored document '{doc.title}' ({doc_id})")
    return doc

# 文档 id 查看
@router.delete("/documents/{doc_id}")
async def delete_document(
    doc_id: UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a document from the knowledge base.

    Two stores to clean, with different semantics: the vector store is
    soft-deleted (row stays, ``is_active`` filters it out of retrieval), while
    the knowledge graph must be told explicitly — LightRAG has no soft delete,
    so an untouched graph keeps answering from the deleted document.
    """
    from sqlalchemy import select
    from app.models.chat import Document
    from app.rag.ingest import DocumentSnapshot, remove_from_graph

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

    # Commit before scheduling: the background task gets its own DB session and
    # must not race the soft delete.
    await db.commit()

    # Graph removal rebuilds affected entities when needed, which costs LLM
    # calls — keep it off the request path.
    background_tasks.add_task(remove_from_graph, DocumentSnapshot.of(doc))

    return {"message": "Document deleted", "graph_cleanup": "scheduled"}
