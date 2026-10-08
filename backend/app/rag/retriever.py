"""
RAG retrieval pipeline - chunks documents, stores embeddings, retrieves relevant context
"""
import re
from typing import List, Optional
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from loguru import logger

from app.core.config import settings
from app.models.chat import Document, DocumentChunk
from app.rag.embeddings import embedding_service
from app.schemas.chat import RAGContext

# CJK ideographs, kana and hangul. Space-delimited tokenisation collapses these
# into a handful of enormous "words", so they need character-based chunking.
_CJK_RE = re.compile(
    r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]"
)
# Split *after* sentence-ending punctuation, keeping the delimiter.
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[。！？；!?;\n])")

# Above this share of CJK characters a document is chunked by character.
CJK_RATIO_THRESHOLD = 0.1


class TextChunker:
    """Splits documents into overlapping chunks.

    ``chunk_size``/``overlap`` are measured in **words for Latin text** and in
    **characters for CJK text** — a Chinese document has few spaces, so word
    counting there would collapse the whole file into one chunk.
    """

    def __init__(self, chunk_size: int = 512, overlap: int = 50):
        self.chunk_size = chunk_size
        self.overlap = overlap

    def chunk(self, text: str) -> List[str]:
        if not text.strip():
            return []
        if self._cjk_ratio(text) >= CJK_RATIO_THRESHOLD:
            return self._chunk_cjk(text)
        return self._chunk_words(text)

    @staticmethod
    def _cjk_ratio(text: str) -> float:
        return len(_CJK_RE.findall(text)) / max(len(text), 1)

    # ------------------------------------------------------------------
    # Latin: split on whitespace
    # ------------------------------------------------------------------
    def _chunk_words(self, text: str) -> List[str]:
        words = text.split()
        chunks, i = [], 0
        step = max(self.chunk_size - self.overlap, 1)
        while i < len(words):
            chunk_words = words[i: i + self.chunk_size]
            chunks.append(" ".join(chunk_words))
            i += step
        return [c for c in chunks if c.strip()]

    # ------------------------------------------------------------------
    # CJK: pack sentences up to a character budget
    # ------------------------------------------------------------------
    def _chunk_cjk(self, text: str) -> List[str]:
        size = max(self.chunk_size, 1)
        units = self._sentence_units(text, size)

        chunks: List[str] = []
        current = ""
        for unit in units:
            if current and len(current) + len(unit) > size:
                chunks.append(current)
                # Carry the tail of the finished chunk so context spans the seam.
                tail = current[-self.overlap:] if self.overlap > 0 else ""
                current = tail + unit
            else:
                current += unit
        if current.strip():
            chunks.append(current)

        return [c.strip() for c in chunks if c.strip()]

    @staticmethod
    def _sentence_units(text: str, size: int) -> List[str]:
        """Sentences, with any sentence longer than ``size`` hard-sliced."""
        units: List[str] = []
        for sentence in _SENTENCE_SPLIT_RE.split(text):
            if not sentence or not sentence.strip():
                continue
            if len(sentence) <= size:
                units.append(sentence)
            else:
                units.extend(
                    sentence[i: i + size] for i in range(0, len(sentence), size)
                )
        return units


class RAGRetriever:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.chunker = TextChunker(
            chunk_size=settings.RAG_CHUNK_SIZE,
            overlap=settings.RAG_CHUNK_OVERLAP,
        )

    # ------------------------------------------------------------------
    # Indexing
    # ------------------------------------------------------------------
    async def index_document(self, document: Document) -> int:
        """Chunk a document and store embeddings. Returns chunk count."""
        # Delete old chunks
        old_chunks = await self.db.execute(
            select(DocumentChunk).where(DocumentChunk.document_id == document.id)
        )
        for chunk in old_chunks.scalars().all():
            await self.db.delete(chunk)
        await self.db.flush()

        chunks = self.chunker.chunk(document.content)
        if not chunks:
            logger.warning(f"No chunks for document {document.id}")
            return 0

        embeddings = await embedding_service.embed_batch(chunks)

        for idx, (chunk_text, emb) in enumerate(zip(chunks, embeddings)):
            chunk = DocumentChunk(
                document_id=document.id,
                organization_id=document.organization_id,
                chunk_index=idx,
                content=chunk_text,
                embedding=emb,
                metadata_={"doc_title": document.title, "source": document.source},
            )
            self.db.add(chunk)

        await self.db.flush()
        logger.info(f"Indexed {len(chunks)} chunks for document '{document.title}'")
        return len(chunks)

    # ------------------------------------------------------------------
    # Retrieval (pgvector cosine similarity)
    # ------------------------------------------------------------------
    async def retrieve(
        self,
        query: str,
        organization_id: UUID,
        top_k: Optional[int] = None,
        similarity_threshold: Optional[float] = None,
    ) -> List[RAGContext]:
        k = top_k or settings.RAG_TOP_K
        threshold = similarity_threshold or settings.RAG_SIMILARITY_THRESHOLD

        query_embedding = await embedding_service.embed_text(query)

        # Format for pgvector
        emb_str = "[" + ",".join(str(v) for v in query_embedding) + "]"

        sql = text("""
            SELECT
                dc.id,
                dc.content,
                dc.metadata,
                d.title,
                1 - (dc.embedding <=> CAST(:embedding AS vector)) AS similarity
            FROM document_chunks dc
            JOIN documents d ON d.id = dc.document_id
            WHERE
                dc.organization_id = :org_id
                AND d.is_active = TRUE
                AND dc.embedding IS NOT NULL
                AND 1 - (dc.embedding <=> CAST(:embedding AS vector)) >= :threshold
            ORDER BY dc.embedding <=> CAST(:embedding AS vector)
            LIMIT :top_k
        """)

        try:
            result = await self.db.execute(
                sql,
                {
                    "embedding": emb_str,
                    "org_id": str(organization_id),
                    "threshold": threshold,
                    "top_k": k,
                },
            )
            rows = result.fetchall()
        except Exception as e:
            logger.error(f"pgvector retrieval failed: {e}. Falling back to text search.")
            return await self._text_fallback(query, organization_id, k)

        contexts = []
        for row in rows:
            contexts.append(
                RAGContext(
                    chunk_id=str(row.id),
                    document_title=row.title,
                    content=row.content,
                    similarity_score=round(float(row.similarity), 4),
                )
            )

        logger.info(f"RAG retrieved {len(contexts)} chunks for query: '{query[:60]}...'")
        return contexts

    async def _text_fallback(
        self, query: str, organization_id: UUID, top_k: int
    ) -> List[RAGContext]:
        """Full-text search fallback when vector search is unavailable."""
        query_words = query.lower().split()
        result = await self.db.execute(
            select(DocumentChunk, Document.title)
            .join(Document, Document.id == DocumentChunk.document_id)
            .where(
                DocumentChunk.organization_id == organization_id,
                Document.is_active == True,
            )
            .limit(200)
        )
        rows = result.all()

        scored = []
        for chunk, title in rows:
            text_lower = chunk.content.lower()
            score = sum(1 for w in query_words if w in text_lower) / max(len(query_words), 1)
            if score > 0:
                scored.append((score, chunk, title))

        scored.sort(reverse=True, key=lambda x: x[0])

        return [
            RAGContext(
                chunk_id=str(c.id),
                document_title=t,
                content=c.content,
                similarity_score=round(s, 4),
            )
            for s, c, t in scored[:top_k]
        ]

    # ------------------------------------------------------------------
    # Prompt building
    # ------------------------------------------------------------------
    def build_augmented_prompt(
        self,
        user_message: str,
        contexts: List[RAGContext],
        conversation_history: List[dict],
        system_prompt: Optional[str] = None,
    ) -> List[dict]:
        """Build the full message list for the LLM."""
        base_system = system_prompt or (
            "You are a helpful enterprise AI assistant. "
            "Answer questions accurately and concisely based on the provided context. "
            "If the context does not contain enough information, say so clearly."
        )

        if contexts:
            context_block = "\n\n".join(
                f"[Source: {c.document_title}]\n{c.content}" for c in contexts
            )
            system_content = (
                f"{base_system}\n\n"
                f"## Relevant Context\n{context_block}\n\n"
                "Use the context above to answer the user's question. "
                "Cite the source when referencing specific information."
            )
        else:
            system_content = base_system

        messages = [{"role": "system", "content": system_content}]

        # Last N turns of history (keep context window manageable)
        for msg in conversation_history[-10:]:
            messages.append({"role": msg["role"], "content": msg["content"]})

        messages.append({"role": "user", "content": user_message})
        return messages
