"""
Application Configuration
"""
from typing import List, Optional
from pydantic_settings import BaseSettings
from pydantic import validator

# 相关设置
class Settings(BaseSettings):
    # App：名称、版本、环境、是否调试状态、
    APP_NAME: str = "Enterprise Chatbot"
    APP_VERSION: str = "1.0.0"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True
    SECRET_KEY: str = "change-this-in-production-very-long-secret-key"
    
    # Database：数据库地址，池大小
    DATABASE_URL: str = "postgresql+asyncpg://chatbot:chatbot_pass@db:5432/chatbot_db"
    DATABASE_POOL_SIZE: int = 10
    DATABASE_MAX_OVERFLOW: int = 20
    
    # Redis：Redis 缓存地址
    REDIS_URL: str = "redis://redis:6379/0"
    
    # JWT：
    JWT_SECRET_KEY: str = "jwt-secret-key-change-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: int = 30


    # 大模型相关配置，base_url 和 api_key
    # LLM / Embedding providers (OpenAI-compatible endpoints)
    # OPENAI_* is the shared fallback used by both services.
    # Set LLM_* / EMBEDDING_* to point each service at a different provider.
    OPENAI_BASE_URL: str = ""
    OPENAI_API_KEY: str = ""

    # Chat / LLM
    LLM_BASE_URL: str = ""
    LLM_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o"
    OPENAI_MAX_TOKENS: int = 2048
    OPENAI_TEMPERATURE: float = 0.7

    # Embeddings
    EMBEDDING_BASE_URL: str = ""
    EMBEDDING_API_KEY: str = ""
    OPENAI_EMBEDDING_MODEL: str = "text-embedding-3-small"

    # SSE — idle interval before sending a keep-alive comment frame.
    # Lower it if a proxy in front of the app drops idle connections sooner.
    SSE_HEARTBEAT_SECONDS: float = 15.0

    # RAG 后端
    # Which retrieval implementation serves the chat pipeline:
    #   legacy   -> pgvector cosine search (RAGRetriever)
    #   lightrag -> LightRAG knowledge-graph layer (LightRAGRetriever)
    RAG_BACKEND: str = "legacy"

    # LightRAG (knowledge-graph layer only — generation stays with llm_service)
    LIGHTRAG_DATA_DIR: str = "lightrag_data"   # graph/vector/kv files, per workspace
    LIGHTRAG_QUERY_MODE: str = "hybrid"        # local | global | hybrid | mix | naive
    LIGHTRAG_MAX_GLEANING: int = 1             # entity-extraction passes per chunk
    # Mirror every ingested document into the knowledge graph even when
    # RAG_BACKEND=legacy, so the graph stays in step with the knowledge base.
    # Costs LLM entity-extraction calls on every ingest.
    LIGHTRAG_INDEX_ALWAYS: bool = True

    # Chunk size/overlap are counted in words for Latin text and in characters
    # for CJK text (Chinese has few spaces, so word counts collapse the file).
    RAG_TOP_K: int = 5
    RAG_SIMILARITY_THRESHOLD: float = 0.5
    RAG_CHUNK_SIZE: int = 512
    RAG_CHUNK_OVERLAP: int = 50
    EMBEDDING_DIMENSION: int = 1536
    
    # Rate limiting
    RATE_LIMIT_PER_MINUTE: int = 30
    RATE_LIMIT_PER_HOUR: int = 300
    RATE_LIMIT_PER_DAY: int = 1000
    
    # CORS & Security：跨域请求运行的网址
    ALLOWED_ORIGINS: List[str] = ["http://localhost:3000", "http://localhost:5173"]
    ALLOWED_HOSTS: List[str] = ["*"]
    
    # Logging：日志
    LOG_LEVEL: str = "INFO"
    LOG_FILE: str = "logs/app.log"
    
    # File uploads：上传文件限制
    MAX_UPLOAD_SIZE_MB: int = 10
    UPLOAD_DIR: str = "uploads"

    @property
    def llm_base_url(self) -> Optional[str]:
        """Base URL for the chat model; empty/blank means the SDK default."""
        return self.LLM_BASE_URL or self.OPENAI_BASE_URL or None

    @property
    def llm_api_key(self) -> str:
        return self.LLM_API_KEY or self.OPENAI_API_KEY

    @property
    def embedding_base_url(self) -> Optional[str]:
        """Base URL for the embedding model; empty/blank means the SDK default."""
        return self.EMBEDDING_BASE_URL or self.OPENAI_BASE_URL or None

    @property
    def embedding_api_key(self) -> str:
        return self.EMBEDDING_API_KEY or self.OPENAI_API_KEY

    class Config:
        env_file = ".env"
        case_sensitive = True
        # .env also carries docker-compose / frontend-only keys
        # (POSTGRES_*, REDIS_PASSWORD, VITE_API_URL) — ignore them here.
        extra = "ignore"


settings = Settings()
