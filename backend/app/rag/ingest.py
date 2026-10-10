"""
Single entry point for indexing a document.

Writes to whichever retriever ``RAG_BACKEND`` selects, and — when
``LIGHTRAG_INDEX_ALWAYS`` is on — also mirrors the document into the
knowledge graph so the graph view stays in step with the knowledge base.

The mirror is best-effort: graph extraction costs several LLM calls, so it runs
off the request path (``BackgroundTasks``) where possible, and a failure is
logged loudly but never fails the document ingest. Losing a graph edge is
recoverable; rejecting the user's upload is not.
"""
import os
from dataclasses import dataclass
from typing import Dict, List, Optional
from uuid import UUID

from loguru import logger

from app.core.config import settings
from app.rag.factory import get_retriever

# In-flight graph work, keyed by "<kind>:<document id>".
#
# Graph indexing and deletion both cost LLM calls and run in the background, so
# the graph lags the document list by seconds to minutes. Without this the UI
# just shows stale data with no explanation. Process-local on purpose: it only
# needs to be good enough for the UI to say "still catching up", and a
# single-node deployment has one process anyway.
_PENDING: Dict[str, Dict] = {}


def _begin(kind: str, document_id: str, title: str) -> str:
    key = f"{kind}:{document_id}"
    _PENDING[key] = {"kind": kind, "document_id": document_id, "title": title}
    return key


def _end(key: str) -> None:
    _PENDING.pop(key, None)


def pending_graph_tasks() -> List[Dict]:
    """Tasks currently keeping the graph behind the document list."""
    return sorted(_PENDING.values(), key=lambda t: t["document_id"])


@dataclass(frozen=True)
class DocumentSnapshot:
    """Plain copy of what both indexers need.

    Detached from the ORM instance on purpose: the graph mirror may run after
    the request's DB session is gone.
    """

    id: str
    organization_id: UUID
    title: str
    source: Optional[str]
    content: str

    @classmethod
    def of(cls, document) -> "DocumentSnapshot":
        return cls(
            id=str(getattr(document, "id", "") or ""),
            organization_id=document.organization_id,
            title=getattr(document, "title", "") or "document",
            source=getattr(document, "source", None),
            content=document.content,
        )


def mirror_enabled() -> bool:
    """True when the graph should be written in addition to the primary store.

    ``lightrag`` already writes the graph, and ``hybrid`` writes both stores
    itself — mirroring again would duplicate the expensive LLM extraction.
    """
    return (
        settings.LIGHTRAG_INDEX_ALWAYS
        and settings.RAG_BACKEND not in ("lightrag", "hybrid")
    )


async def _current_state(document_id: str) -> Optional[bool]:
    """Re-read ``is_active`` for a document, or None if it no longer exists.

    Background tasks are scheduled against a snapshot and may run long after
    the request. A delete followed immediately by a restore queues the removal
    *before* the re-index, so a task must act on the document's state now, not
    the state at scheduling time — otherwise the stale removal wins and quietly
    strips an active document out of the graph.
    """
    from uuid import UUID as _UUID

    from sqlalchemy import select

    from app.db.session import AsyncSessionLocal
    from app.models.chat import Document

    try:
        async with AsyncSessionLocal() as db:
            row = await db.execute(
                select(Document.is_active).where(Document.id == _UUID(document_id))
            )
            return row.scalar_one_or_none()
    except Exception as e:  # noqa: BLE001 - fall back to acting on the snapshot
        logger.warning(f"Could not re-read state for document {document_id}: {e}")
        return None


async def mirror_to_graph(snapshot: DocumentSnapshot) -> None:
    """Extract entities/relations for ``snapshot`` into the LightRAG graph."""
    if await _current_state(snapshot.id) is False:
        logger.info(f"Skipping graph indexing for '{snapshot.title}': deleted while queued")
        return

    key = _begin("index", snapshot.id, snapshot.title)
    try:
        from app.rag.lightrag_retriever import LightRAGRetriever

        await LightRAGRetriever().index_document(snapshot)
    except Exception as e:  # noqa: BLE001 - never fail the primary ingest
        logger.error(
            f"Graph mirror failed for '{snapshot.title}' — the document is indexed "
            f"and searchable, but it will not appear in the knowledge graph: {e}"
        )
    finally:
        _end(key)


async def _graph_doc_id_for_path(rag, source: Optional[str]) -> Optional[str]:
    """Find the id LightRAG keyed a source file under.

    LightRAG stores a canonical *basename* as ``file_path`` and de-duplicates on
    it, so the graph entry may live under a different id than the Postgres row
    being deleted. Re-submissions show up as ``dup-<hash>`` markers — those are
    not the real entry, so a real one always wins.
    """
    if not source:
        return None
    try:
        from lightrag.base import DocStatus

        rows = await rag.doc_status.get_docs_by_statuses(list(DocStatus))
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Could not resolve graph id for '{source}': {e}")
        return None

    want = os.path.basename(source)
    fallback = None
    for doc_id, row in (rows or {}).items():
        data = row if isinstance(row, dict) else getattr(row, "__dict__", {})
        if data.get("file_path") != want:
            continue
        if not str(doc_id).startswith("dup-"):
            return str(doc_id)
        fallback = fallback or str(doc_id)
    return fallback


async def remove_from_graph(snapshot: DocumentSnapshot) -> None:
    """Delete a document's chunks and derived graph elements.

    The vector store soft-deletes (``is_active = False`` filters it out of
    retrieval), but LightRAG has no such concept — if we do not remove the
    document here it keeps answering from the graph forever.

    This can be slow: when entities or relations were only supported by this
    document, LightRAG rebuilds them, which costs LLM calls. Hence background.
    """
    if await _current_state(snapshot.id) is True:
        logger.info(f"Skipping graph deletion for '{snapshot.title}': restored while queued")
        return

    # 每次上传在图谱里都是独立条目（file_path 带唯一后缀，见
    # lightrag_retriever.graph_file_path），所以直接按 id 删即可，不会误伤
    # 同名文件。not_found 只可能来自本次改造之前入库的旧数据，用文件名兜底。
    key = _begin("delete", snapshot.id, snapshot.title)
    try:
        from app.rag.lightrag_retriever import get_engine

        rag = await get_engine(snapshot.organization_id)

        result = await rag.adelete_by_doc_id(snapshot.id)
        if result.status == "not_found":
            # Fall back to the id LightRAG actually keyed this file under.
            graph_id = await _graph_doc_id_for_path(rag, snapshot.source)
            if graph_id and graph_id != snapshot.id:
                logger.info(
                    f"'{snapshot.title}' has no graph entry under its own id; "
                    f"deleting the entry keyed on the same file instead"
                )
                result = await rag.adelete_by_doc_id(graph_id)

        logger.info(
            f"Graph deletion for '{snapshot.title}': {result.status} — {result.message}"
        )
    except Exception as e:  # noqa: BLE001 - the document is already gone from the UI
        logger.error(
            f"Graph deletion failed for '{snapshot.title}' — it is hidden from vector "
            f"search but may still be reachable through the knowledge graph: {e}"
        )
    finally:
        _end(key)


async def index_document(document, db=None, background=None) -> int:
    """Index ``document`` into every store the configured backend uses.

    Written as an orchestrator rather than a single ``retriever.index_document``
    call because the two stores have very different costs:

    * **vector** — one embedding request, so it stays synchronous. Retrieval
      must work the moment the upload returns.
    * **graph** — several LLM calls for entity/relationship extraction (seconds
      to minutes on a large file), so it goes to ``background`` whenever the
      caller supplies one.

    ``background`` is a FastAPI ``BackgroundTasks``. Callers without one (the
    CLI ingest script) get a synchronous graph build.
    """
    backend = (settings.RAG_BACKEND or "legacy").strip().lower()

    # --- vector store (fast, always synchronous) ---
    chunk_count = 0
    if backend in ("legacy", "hybrid"):
        from app.rag.retriever import RAGRetriever

        chunk_count = await RAGRetriever(db).index_document(document)

    # --- knowledge graph ---
    if backend == "lightrag":
        # Here the graph *is* the retrieval store, so it cannot be deferred —
        # there would be nothing to search until it finished.
        await get_retriever(db).index_document(document)
    elif backend == "hybrid" or mirror_enabled():
        snapshot = DocumentSnapshot.of(document)
        if background is not None:
            background.add_task(mirror_to_graph, snapshot)
            logger.info(f"Queued graph indexing for '{snapshot.title}'")
        else:
            await mirror_to_graph(snapshot)

    return chunk_count
