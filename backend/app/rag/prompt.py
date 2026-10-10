"""
Prompt assembly for the RAG pipeline.

Kept out of the retriever classes: building the message list is independent of
*how* the context was retrieved, so both the legacy vector pipeline and the
LightRAG graph pipeline share this.
"""
from typing import List, Optional

from app.schemas.chat import RAGContext

# 默认系统提示词
DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful enterprise AI assistant. "
    "Answer questions accurately and concisely based on the provided context. "
    "If the context does not contain enough information, say so clearly."
)

# How many prior turns to replay into the prompt.
MAX_HISTORY_TURNS = 10

# 增强提示词构建
def build_augmented_prompt(
    user_message: str,
    contexts: List[RAGContext],
    conversation_history: List[dict],
    system_prompt: Optional[str] = None,
) -> List[dict]:
    """Build the full message list for the LLM."""
    base_system = system_prompt or DEFAULT_SYSTEM_PROMPT

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

    for msg in conversation_history[-MAX_HISTORY_TURNS:]:
        messages.append({"role": msg["role"], "content": msg["content"]})

    messages.append({"role": "user", "content": user_message})
    return messages
