"""
Application Configuration
"""
from typing import List, Optional
from pydantic_settings import BaseSettings
from pydantic import validator


class Settings(BaseSettings):
    # App
    APP_NAME: str = "Enterprise Chatbot"
    APP_VERSION: str = "1.0.0"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True
    SECRET_KEY: str = "change-this-in-production-very-long-secret-key"
    
    # Database
    DATABASE_URL: str = "postgresql+asyncpg://chatbot:chatbot_pass@db:5432/chatbot_db"
    DATABASE_POOL_SIZE: int = 10
    DATABASE_MAX_OVERFLOW: int = 20
    
    # Redis
    REDIS_URL: str = "redis://redis:6379/0"
    
    # JWT
    JWT_SECRET_KEY: str = "jwt-secret-key-change-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: int = 30
    
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

    # RAG
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
    
    # CORS & Security
    ALLOWED_ORIGINS: List[str] = ["http://localhost:3000", "http://localhost:5173"]
    ALLOWED_HOSTS: List[str] = ["*"]
    
    # Logging
    LOG_LEVEL: str = "INFO"
    LOG_FILE: str = "logs/app.log"
    
    # File uploads
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
