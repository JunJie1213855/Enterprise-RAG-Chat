"""
Hybrid retrieval — runs the vector and graph pipelines together and fuses them.

Why fusion rather than averaging: the two paths produce **incommensurable
scores**. The vector retriever returns cosine similarity (absolute, comparable
across queries); the graph retriever returns a rank proxy because LightRAG's
``aquery_data`` reports no similarity at all. Averaging those numbers would be
meaningless, and weighting them would need recalibration every time the
embedding model changes.

So we fuse on **rank** instead, using Reciprocal Rank Fusion:

    score(doc) = Σ_paths 1 / (RRF_K + rank_in_that_path)

RRF needs no score normalisation and is robust when one path returns a poor
ranking — a document that both paths rank highly wins, and a document that only
one path finds still surfaces (just lower). ``RRF_K`` damps the influence of the
very top ranks; 60 is the value from the original Cormack et al. paper and is
what most implementations use.

Ingestion writes to **both** stores, so either path can answer on its own and
the app degrades gracefully if one of them is unavailable.
"""
import asyncio
import hashlib
from typing import List, Optional, Sequence
from uuid import UUID

from loguru import logger

from app.core.config import settings
from app.rag.prompt import build_augmented_prompt
from app.schemas.chat import RAGContext

# RRF damping constant (Cormack et al. 2009). Higher = flatter rank weighting.
RRF_K = 60


def _dedup_key(ctx: RAGContext) -> str:
    """Identity of a chunk across paths.

    The two stores chunk differently (character-based vs tiktoken), so the same
    source text can come back as slightly different strings with different
    chunk ids. Keying on a normalised content prefix collapses those duplicates
    without merging genuinely distinct chunks.
    """
    normalised = " ".join(ctx.content.split())[:200]
    return hashlib.sha1(normalised.encode("utf-8")).hexdigest()


def fuse_rankings(
    ranked_lists: Sequence[Sequence[RAGContext]],
    top_n: int,
    rrf_k: int = RRF_K,
) -> List[RAGContext]:
    """Merge several ranked result lists into one, by Reciprocal Rank Fusion."""
    scores: dict[str, float] = {}
    representative: dict[str, RAGContext] = {}
    hit_paths: dict[str, int] = {}

    for results in ranked_lists:
        for rank, ctx in enumerate(results, start=1):
            key = _dedup_key(ctx)
            scores[key] = scores.get(key, 0.0) + 1.0 / (rrf_k + rank)
            hit_paths[key] = hit_paths.get(key, 0) + 1
            # Prefer whichever path produced the richer text for this chunk.
            prior = representative.get(key)
            if prior is None or len(ctx.content) > len(prior.content):
                representative[key] = ctx

    ordered = sorted(scores, key=lambda k: scores[k], reverse=True)[:top_n]

    fused: List[RAGContext] = []
    for key in ordered:
        ctx = representative[key]
        fused.append(
            ctx.model_copy(
                update={
                    # The field is named similarity_score but now carries an RRF
                    # score — deliberately small (≈0.016–0.033) and only
                    # meaningful relative to the other results in this response.
                    "similarity_score": round(scores[key], 4),
                }
            )
        )
    return fused


class HybridRetriever:
    """Queries both pipelines concurrently and fuses the results."""

    def __init__(self, db=None):
        # Imported here to keep this module importable without the heavy
        # LightRAG dependency being loaded for the legacy-only path.
        from app.rag.lightrag_retriever import LightRAGRetriever
        from app.rag.retriever import RAGRetriever

        self.db = db
        self.vector = RAGRetriever(db)
        self.graph = LightRAGRetriever(db)

    # ------------------------------------------------------------------
    # Indexing — both stores, so either path can serve alone
    # ------------------------------------------------------------------
    async def index_document(self, document) -> int:
        """Write to the vector store and the knowledge graph."""
        chunk_count = await self.vector.index_document(document)

        # The graph mirror runs inline: the caller (ingest.index_document)
        # already decides whether that work belongs on a background task.
        try:
            await self.graph.index_document(document)
        except Exception as e:  # noqa: BLE001 - the vector index is authoritative
            logger.error(
                f"Graph indexing failed for '{getattr(document, 'title', '?')}' — "
                f"the document is searchable by vector search but will not appear "
                f"in the knowledge graph: {e}"
            )

        return chunk_count

    # ------------------------------------------------------------------
    # Retrieval — both paths concurrently, fused by rank
    # ------------------------------------------------------------------
    async def retrieve(
        self,
        query: str,
        organization_id: UUID,
        k: Optional[int] = None,
    ) -> List[RAGContext]:
        top_k = k or settings.RAG_TOP_K

        # Ask each path for a few more than we need: after dedup a path may
        # contribute fewer than top_k distinct chunks.
        per_path = max(top_k, 1) * 2

        vector_result, graph_result = await asyncio.gather(
            self.vector.retrieve(query, organization_id, per_path),
            self.graph.retrieve(query, organization_id, per_path),
            return_exceptions=True,
        )

        ranked_lists: List[List[RAGContext]] = []
        for label, result in (("vector", vector_result), ("graph", graph_result)):
            if isinstance(result, BaseException):
                # One path failing must not fail the request — the other still
                # answers. Logged loudly because a silent half-outage would
                # otherwise look like "retrieval got worse".
                logger.error(f"Hybrid retrieval: {label} path failed: {result}")
                continue
            ranked_lists.append(result)

        if not ranked_lists:
            logger.error("Hybrid retrieval: both paths failed; returning no context")
            return []

        counts = [len(r) for r in ranked_lists]
        fused = fuse_rankings(ranked_lists, top_n=top_k)
        logger.info(
            f"Hybrid retrieval for '{query[:50]}': vector={counts[0] if counts else 0}, "
            f"graph={counts[1] if len(counts) > 1 else 0} -> {len(fused)} fused"
        )
        return fused

    # ------------------------------------------------------------------
    # Prompt building (shared)
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
