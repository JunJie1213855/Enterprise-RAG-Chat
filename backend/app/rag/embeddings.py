"""
Embedding service - generates vector embeddings using OpenAI or fallback
"""
from typing import List, Optional
import numpy as np
from loguru import logger
from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import settings


class EmbeddingService:
    def __init__(self):
        self.model = settings.OPENAI_EMBEDDING_MODEL
        self.dimension = settings.EMBEDDING_DIMENSION
        self._client = None

    def _get_client(self):
        if not self._client:
            from openai import AsyncOpenAI
            self._client = AsyncOpenAI(
                api_key=settings.embedding_api_key,
                base_url=settings.embedding_base_url,
            )
        return self._client

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
    async def embed_text(self, text: str) -> List[float]:
        """Generate embedding for a single text."""
        if not settings.embedding_api_key:
            return self._fallback_embedding(text)
        try:
            client = self._get_client()
            response = await client.embeddings.create(
                model=self.model,
                input=text[:8000],  # token limit guard
            )
            return response.data[0].embedding
        except Exception as e:
            logger.error(f"Embedding error: {e}")
            return self._fallback_embedding(text)

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
    async def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """Generate embeddings for multiple texts."""
        if not settings.embedding_api_key:
            return [self._fallback_embedding(t) for t in texts]
        try:
            client = self._get_client()
            cleaned = [t[:8000] for t in texts]
            response = await client.embeddings.create(
                model=self.model,
                input=cleaned,
            )
            return [item.embedding for item in response.data]
        except Exception as e:
            logger.error(f"Batch embedding error: {e}")
            return [self._fallback_embedding(t) for t in texts]

    def _fallback_embedding(self, text: str) -> List[float]:
        """Deterministic pseudo-embedding for when API is unavailable."""
        rng = np.random.default_rng(abs(hash(text)) % (2**32))
        vec = rng.standard_normal(self.dimension).astype(np.float32)
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm
        return vec.tolist()

    def cosine_similarity(self, a: List[float], b: List[float]) -> float:
        va, vb = np.array(a), np.array(b)
        denom = np.linalg.norm(va) * np.linalg.norm(vb)
        return float(np.dot(va, vb) / denom) if denom > 0 else 0.0


embedding_service = EmbeddingService()
