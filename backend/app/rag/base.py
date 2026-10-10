"""
Retriever contract shared by the legacy vector pipeline and the LightRAG
knowledge-graph pipeline.

Keeping both behind one interface means the chat API, the SSE stream and the
prompt builder never learn which backend answered — that is what makes
RAG_BACKEND=legacy|lightrag a one-line switch (and an A/B comparison possible).
"""
from typing import List, Optional, Protocol, runtime_checkable
from uuid import UUID

from app.schemas.chat import RAGContext


# 接口定义
@runtime_checkable
class Retriever(Protocol):
    """Organization-scoped retrieval over an indexed knowledge base."""
    # 检索 API
    async def retrieve(
        self,
        query: str,
        organization_id: UUID,
        k: Optional[int] = None,
    ) -> List[RAGContext]:
        """Return the most relevant chunks for ``query`` within one org."""
        ...
    # 索引建立 API
    async def index_document(self, document) -> int:
        """Chunk, embed and store ``document``. Returns the chunk count."""
        ...
