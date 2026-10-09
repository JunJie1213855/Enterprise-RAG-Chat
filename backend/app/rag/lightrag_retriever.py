"""
LightRAG-backed retrieval — knowledge-graph layer only.

We deliberately use only the graph half of LightRAG:

  * its **text processing** (tiktoken-based chunker, CJK-friendly) and
  * its **entity/relationship extraction + graph retrieval** via
    ``aquery_data``, which returns structured entities/relations/chunks and
    never calls an LLM to generate an answer.

Generation stays with our own ``llm_service`` so streaming (SSE), provider
configuration and the RAGContext contract are all unchanged.

One LightRAG instance is kept per organization — its ``workspace`` field gives
us the multi-tenant isolation, and rebuilding the graph handle per request
would be far too expensive.
"""
import asyncio
import os
from functools import partial
from pathlib import Path
from typing import Dict, List, Optional
from uuid import UUID

from loguru import logger

from app.core.config import settings
from app.rag.llm_service import llm_service
from app.rag.prompt import build_augmented_prompt
from app.schemas.chat import RAGContext

# workspace -> LightRAG instance
_ENGINES: Dict[str, "object"] = {}
_LOCKS: Dict[str, asyncio.Lock] = {}


def _lock_for(key: str) -> asyncio.Lock:
    if key not in _LOCKS:
        _LOCKS[key] = asyncio.Lock()
    return _LOCKS[key]


def _build_llm_func():
    """Adapt our llm_service to LightRAG's ``llm_model_func`` contract.

    Used only for entity/relationship extraction at ingest time — never for
    answering user questions.
    """
    async def _llm_model_func(
        prompt: str,
        system_prompt: Optional[str] = None,
        history_messages: Optional[list] = None,
        **kwargs,
    ) -> str:
        messages: List[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.extend(history_messages or [])
        messages.append({"role": "user", "content": prompt})

        # LightRAG asks for JSON when parsing entities/keywords. Without it the
        # model answers in prose, parsing fails and it silently falls back to
        # using the raw query as the keyword — which guts graph recall.
        response_format = None
        if kwargs.get("keyword_extraction"):
            response_format = {"type": "json_object"}

        text, _ = await llm_service.chat(messages, response_format=response_format)
        return text

    return _llm_model_func


def _build_embedding_func():
    from lightrag.llm.openai import openai_embed
    from lightrag.utils import EmbeddingFunc

    # openai_embed is already wrapped in an EmbeddingFunc; reuse the inner
    # function to avoid double wrapping (which would re-validate dimensions).
    base = getattr(openai_embed, "func", openai_embed)

    return EmbeddingFunc(
        embedding_dim=settings.EMBEDDING_DIMENSION,
        max_token_size=8192,
        model_name=settings.OPENAI_EMBEDDING_MODEL,
        func=partial(
            base,
            model=settings.OPENAI_EMBEDDING_MODEL,
            base_url=settings.embedding_base_url,
            api_key=settings.embedding_api_key,
        ),
    )


async def get_engine(organization_id: UUID):
    """Return the initialized LightRAG instance for one organization."""
    key = str(organization_id)
    if key in _ENGINES:
        return _ENGINES[key]

    async with _lock_for(key):
        if key in _ENGINES:  # another coroutine won the race
            return _ENGINES[key]

        from lightrag import LightRAG
        from lightrag.kg.shared_storage import initialize_pipeline_status

        working_dir = Path(settings.LIGHTRAG_DATA_DIR) / key
        working_dir.mkdir(parents=True, exist_ok=True)

        rag = LightRAG(
            working_dir=str(working_dir),
            workspace=key,
            llm_model_func=_build_llm_func(),
            llm_model_name=settings.OPENAI_MODEL,
            embedding_func=_build_embedding_func(),
            # File-backed stores: the graph is what we query, and keeping it on
            # disk avoids LightRAG creating its own tables in our database.
            kv_storage="JsonKVStorage",
            vector_storage="NanoVectorDBStorage",
            graph_storage="NetworkXStorage",
            doc_status_storage="JsonDocStatusStorage",
            entity_extract_max_gleaning=settings.LIGHTRAG_MAX_GLEANING,
        )
        await rag.initialize_storages()
        await initialize_pipeline_status()

        _ENGINES[key] = rag
        logger.info(f"LightRAG workspace '{key}' initialized at {working_dir}")
        return rag


async def close_engines() -> None:
    """Release every workspace's storages (called on app shutdown)."""
    for key, rag in list(_ENGINES.items()):
        try:
            await rag.finalize_storages()
        except Exception as e:  # noqa: BLE001 - shutdown must not raise
            logger.warning(f"Failed to finalize LightRAG workspace '{key}': {e}")
        _ENGINES.pop(key, None)

# LightRAG 检索器
class LightRAGRetriever:
    """Graph-based retriever satisfying the shared ``Retriever`` protocol."""

    def __init__(self, db=None):
        # Accepted for signature parity with RAGRetriever; LightRAG owns its
        # own storage, so the SQLAlchemy session is unused here.
        self.db = db

    # ------------------------------------------------------------------
    # Indexing
    # ------------------------------------------------------------------
    async def index_document(self, document) -> int:
        """Feed a document through LightRAG's chunker + entity extraction."""
        rag = await get_engine(document.organization_id)

        tracked_id = str(getattr(document, "id", "")) or None
        file_path = getattr(document, "source", None) or getattr(document, "title", "document")

        await rag.ainsert(
            input=document.content,
            ids=tracked_id,
            file_paths=file_path,
        )

        # ainsert returns no chunk count, so read it back from the document
        # status record (DocProcessingStatus.chunks_count).
        count = 0
        try:
            rows = await rag.doc_status.get_by_ids([tracked_id]) if tracked_id else []
            if rows:
                count = int(rows[0].get("chunks_count") or 0)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Could not read back chunk count for '{document.title}': {e}")

        logger.info(
            f"LightRAG indexed '{document.title}' ({file_path}) "
            f"-> {count} chunk(s) in workspace graph"
        )
        return count

    # ------------------------------------------------------------------
    # Retrieval
    # ------------------------------------------------------------------
    async def retrieve(
        self,
        query: str,
        organization_id: UUID,
        k: Optional[int] = None,
    ) -> List[RAGContext]:
        """Graph retrieval returning chunks, with no LLM generation."""
        from lightrag import QueryParam

        rag = await get_engine(organization_id)
        top_k = k or settings.RAG_TOP_K

        result = await rag.aquery_data(
            query,
            param=QueryParam(
                mode=settings.LIGHTRAG_QUERY_MODE,
                top_k=top_k,
                # No rerank model is configured; leaving it on only logs a
                # warning and changes the merge order unpredictably.
                enable_rerank=False,
            ),
        )

        if not isinstance(result, dict) or result.get("status") != "success":
            logger.warning(f"LightRAG query returned no usable data: {str(result)[:200]}")
            return []

        data = result.get("data") or {}
        metadata = result.get("metadata") or {}
        chunks = data.get("chunks") or []

        logger.info(
            f"LightRAG [{metadata.get('query_mode')}] retrieved "
            f"{len(chunks)} chunk(s), {len(data.get('entities') or [])} entit(ies), "
            f"{len(data.get('relationships') or [])} relation(s) for: '{query[:60]}'"
        )

        contexts: List[RAGContext] = []
        for rank, chunk in enumerate(chunks):
            content = (chunk.get("content") or "").strip()
            if not content:
                continue
            file_path = chunk.get("file_path") or ""
            contexts.append(
                RAGContext(
                    chunk_id=str(chunk.get("chunk_id") or f"lr-{rank}"),
                    document_title=os.path.basename(file_path) or file_path or "knowledge-graph",
                    content=content,
                    # aquery_data returns graph-ranked results without a
                    # cosine score, so we expose a rank-based proxy rather
                    # than inventing a similarity.
                    similarity_score=round(max(0.0, 1.0 - rank * 0.01), 4),
                )
            )
        return contexts


    # ------------------------------------------------------------------
    # Prompt building (shared with the legacy retriever)
    # ------------------------------------------------------------------
    def build_augmented_prompt(
        self,
        user_message: str,
        contexts: List[RAGContext],
        conversation_history: List[dict],
        system_prompt: Optional[str] = None,
    ) -> List[dict]:
        return build_augmented_prompt(
            user_message=user_message,
            contexts=contexts,
            conversation_history=conversation_history,
            system_prompt=system_prompt,
        )


lightrag_retriever = LightRAGRetriever()
