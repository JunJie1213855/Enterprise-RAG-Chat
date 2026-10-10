"""
Retriever selection.

``RAG_BACKEND`` picks the implementation; every caller goes through
``get_retriever()`` so the choice stays in one place.
"""
from loguru import logger

from app.core.config import settings
from app.rag.base import Retriever

# 获取检索器
def get_retriever(db=None) -> Retriever:
    """Return the retriever selected by ``settings.RAG_BACKEND``."""
    backend = (settings.RAG_BACKEND or "legacy").strip().lower()

    if backend == "hybrid":
        # Both pipelines: vector + graph, fused by Reciprocal Rank Fusion.
        from app.rag.hybrid_retriever import HybridRetriever
        return HybridRetriever(db)

    if backend == "lightrag":
        from app.rag.lightrag_retriever import LightRAGRetriever
        return LightRAGRetriever(db)

    if backend != "legacy":
        logger.warning(f"Unknown RAG_BACKEND '{backend}'; falling back to 'legacy'")

    from app.rag.retriever import RAGRetriever
    return RAGRetriever(db)
