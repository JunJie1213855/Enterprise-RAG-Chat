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
from dataclasses import dataclass
from typing import Optional
from uuid import UUID

from loguru import logger

from app.core.config import settings
from app.rag.factory import get_retriever


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
    """True when the graph should be written in addition to the primary store."""
    return settings.LIGHTRAG_INDEX_ALWAYS and settings.RAG_BACKEND != "lightrag"


async def mirror_to_graph(snapshot: DocumentSnapshot) -> None:
    """Extract entities/relations for ``snapshot`` into the LightRAG graph."""
    try:
        from app.rag.lightrag_retriever import LightRAGRetriever

        await LightRAGRetriever().index_document(snapshot)
    except Exception as e:  # noqa: BLE001 - never fail the primary ingest
        logger.error(
            f"Graph mirror failed for '{snapshot.title}' — the document is indexed "
            f"and searchable, but it will not appear in the knowledge graph: {e}"
        )


async def index_document(document, db=None, background=None) -> int:
    """Index ``document`` into the primary store, optionally mirroring to the graph.

    ``background`` is a FastAPI ``BackgroundTasks``; pass it from request
    handlers so a slow graph build does not block the HTTP response. Callers
    without one (the CLI ingest script) get a synchronous mirror.
    """
    retriever = get_retriever(db)
    count = await retriever.index_document(document)

    if mirror_enabled():
        snapshot = DocumentSnapshot.of(document)
        if background is not None:
            background.add_task(mirror_to_graph, snapshot)
            logger.info(f"Queued graph mirror for '{snapshot.title}'")
        else:
            await mirror_to_graph(snapshot)

    return count
