"""
Chat Pydantic schemas
1.聊天请求
2.RAG上下文
3.信息响应
4.聊天响应
5.会话响应
6.会话列表响应
7.会话详情响应
8.文档上传请求
9.文档响应
10.会议名称更新请求
"""
from datetime import datetime
from typing import Optional, List, Any
from uuid import UUID

from pydantic import BaseModel


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[UUID] = None
    use_rag: bool = True
    stream: bool = False

    class Config:
        json_schema_extra = {
            "example": {
                "message": "What products do you offer?",
                "session_id": None,
                "use_rag": True,
            }
        }


class RAGContext(BaseModel):
    chunk_id: str
    # Owning document id, when resolvable. Lets the UI open the source document
    # and highlight the passage. None for chunks that cannot be traced back to
    # a document row (e.g. graph chunks whose file_path has no uid suffix).
    document_id: Optional[str] = None
    document_title: str
    content: str
    similarity_score: float


class MessageResponse(BaseModel):
    id: UUID
    session_id: UUID
    role: str
    content: str
    tokens_used: int
    context_used: List[Any]
    created_at: datetime

    model_config = {"from_attributes": True}


class ChatResponse(BaseModel):
    message: MessageResponse
    session_id: UUID
    session_title: str
    rag_context: List[RAGContext] = []
    total_tokens: int


class SessionResponse(BaseModel):
    id: UUID
    title: str
    is_active: bool
    message_count: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SessionListResponse(BaseModel):
    sessions: List[SessionResponse]
    total: int


class SessionDetailResponse(BaseModel):
    id: UUID
    title: str
    is_active: bool
    messages: List[MessageResponse]
    created_at: datetime

    model_config = {"from_attributes": True}


class DocumentUploadRequest(BaseModel):
    title: str
    content: str
    source: Optional[str] = None
    doc_type: str = "text"


class DocumentResponse(BaseModel):
    id: UUID
    title: str
    source: Optional[str]
    doc_type: str
    is_active: bool
    created_at: datetime
    # LightRAG ingest pipeline stage for this document:
    # pending | parsing | analyzing | processing | processed | failed.
    # None when the document never reached the graph (vector-only ingest).
    processing_status: Optional[str] = None

    model_config = {"from_attributes": True}


class DocumentDetailResponse(DocumentResponse):
    # Full text, used to render the document with the retrieved passage
    # highlighted. Only served for the owner's own organization.
    content: str


class ChunkContentsResponse(BaseModel):
    # chunk_id -> chunk text. Missing ids are simply absent from the map.
    chunks: dict[str, str]


class UpdateSessionTitleRequest(BaseModel):
    title: str
