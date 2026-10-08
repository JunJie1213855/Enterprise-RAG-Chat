"""
LLM service - OpenAI chat completions with streaming support
"""
from typing import List, AsyncIterator, Optional
from loguru import logger
from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import settings


class LLMService:
    def __init__(self):
        self._client = None

    def _get_client(self):
        if not self._client:
            from openai import AsyncOpenAI
            self._client = AsyncOpenAI(
                api_key=settings.llm_api_key,
                base_url=settings.llm_base_url,
            )
        return self._client

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
    async def chat(
        self,
        messages: List[dict],
        model: Optional[str] = None,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
    ) -> tuple[str, int]:
        """
        Send messages to LLM and return (response_text, total_tokens).
        Falls back to a stub response if no API key is configured.
        """
        if not settings.llm_api_key:
            return self._stub_response(messages), 0

        client = self._get_client()
        try:
            response = await client.chat.completions.create(
                model=model or settings.OPENAI_MODEL,
                messages=messages,
                max_tokens=max_tokens or settings.OPENAI_MAX_TOKENS,
                temperature=temperature if temperature is not None else settings.OPENAI_TEMPERATURE,
            )
            content = response.choices[0].message.content or ""
            tokens = response.usage.total_tokens if response.usage else 0
            return content, tokens
        except Exception as e:
            logger.error(f"LLM chat error: {e}")
            raise

    async def stream_chat(
        self,
        messages: List[dict],
        model: Optional[str] = None,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
    ) -> AsyncIterator[str]:
        """Stream chat completions token by token."""
        if not settings.llm_api_key:
            stub = self._stub_response(messages)
            for word in stub.split():
                yield word + " "
            return

        client = self._get_client()
        try:
            stream = await client.chat.completions.create(
                model=model or settings.OPENAI_MODEL,
                messages=messages,
                max_tokens=max_tokens or settings.OPENAI_MAX_TOKENS,
                temperature=temperature if temperature is not None else settings.OPENAI_TEMPERATURE,
                stream=True,
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta
                if delta.content:
                    yield delta.content
        except Exception as e:
            logger.error(f"LLM stream error: {e}")
            raise

    def _stub_response(self, messages: List[dict]) -> str:
        """Return a helpful stub when no API key is set."""
        last_user = next(
            (m["content"] for m in reversed(messages) if m["role"] == "user"), ""
        )
        return (
            f"[DEMO MODE — No LLM API key configured]\n\n"
            f"You asked: \"{last_user[:200]}\"\n\n"
            "To enable real AI responses, set LLM_API_KEY (or OPENAI_API_KEY) and "
            "LLM_BASE_URL (or OPENAI_BASE_URL) in the .env file and restart the server."
        )


llm_service = LLMService()
