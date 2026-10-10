"""
Enterprise Chatbot - FastAPI Main Application
"""
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from loguru import logger

from app.core.config import settings
from app.core.logging import setup_logging
from app.db.session import engine, Base
from app.api.v1 import auth, chat, admin, health, graph, metrics
from app.core.middleware import AuditLogMiddleware, RequestIDMiddleware

# 循环调用其
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    setup_logging()
    logger.info("Starting Enterprise Chatbot API...")
    logger.info(f"Environment: {settings.ENVIRONMENT}")
    logger.info(f"Debug mode: {settings.DEBUG}")
    
    # Create database tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("Database tables verified/created")
    
    yield
    
    logger.info("Shutting down Enterprise Chatbot API...")
    await engine.dispose()


# Rate limiter
limiter = Limiter(key_func=get_remote_address)

# FastAPI app
app = FastAPI(
    title=settings.APP_NAME,
    description="Enterprise-grade RAG-powered chatbot with multi-tenant SaaS support",
    version=settings.APP_VERSION,
    docs_url="/api/docs" if settings.DEBUG else None,
    redoc_url="/api/redoc" if settings.DEBUG else None,
    openapi_url="/api/openapi.json" if settings.DEBUG else None,
    lifespan=lifespan,
)

# Rate limiting 频率限制
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS 跨域请求
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Trusted hosts
if settings.ENVIRONMENT == "production":
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=settings.ALLOWED_HOSTS,
    )

# Custom middlewares 
app.add_middleware(AuditLogMiddleware)
app.add_middleware(RequestIDMiddleware)


@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    """Add processing time to response headers."""
    start_time = time.time()
    response = await call_next(request)
    process_time = time.time() - start_time
    response.headers["X-Process-Time"] = str(round(process_time * 1000, 2))
    return response


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Global exception handler."""
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error",
            "request_id": getattr(request.state, "request_id", None),
        },
    )


# Include routers 包含路由
app.include_router(health.router, prefix="/api/v1", tags=["health"])
app.include_router(auth.router, prefix="/api/v1/auth", tags=["authentication"])
app.include_router(chat.router, prefix="/api/v1/chat", tags=["chat"])
app.include_router(graph.router, prefix="/api/v1/chat", tags=["graph"])
app.include_router(admin.router, prefix="/api/v1/admin", tags=["admin"])
app.include_router(metrics.router, prefix="/api/v1", tags=["metrics"])


# 根路由
@app.get("/")
async def root():
    return {
        "message": "Enterprise Chatbot API",
        "version": settings.APP_VERSION,
        "docs": "/api/docs" if settings.DEBUG else "Disabled in production",
    }
