"""
Custom middleware for request tracking and audit logging
"""
import uuid
import time
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from loguru import logger

from app.core import metrics


# 请求ID中间件：给每个请求添加 ID
class RequestIDMiddleware(BaseHTTPMiddleware):
    """Add unique request ID to each request."""
    
    async def dispatch(self, request: Request, call_next):
        request_id = str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response

# 自动日志记录中间件：添加日志
class AuditLogMiddleware(BaseHTTPMiddleware):
    """Log all API requests for audit purposes."""
    
    SKIP_PATHS = {"/api/v1/health", "/", "/favicon.ico"}
    
    async def dispatch(self, request: Request, call_next):
        if request.url.path in self.SKIP_PATHS:
            return await call_next(request)
        
        start_time = time.time()
        
        # Log request
        logger.info(
            f"REQUEST | {request.method} {request.url.path} | "
            f"IP: {request.client.host if request.client else 'unknown'} | "
            f"User-Agent: {request.headers.get('user-agent', 'unknown')[:100]}"
        )
        
        response = await call_next(request)

        process_time = round((time.time() - start_time) * 1000, 2)
        # 累积到运行时指标 —— /metrics 端点读的就是这里
        metrics.record_request(request.url.path, response.status_code, process_time)
        
        # Log response
        logger.info(
            f"RESPONSE | {request.method} {request.url.path} | "
            f"Status: {response.status_code} | "
            f"Duration: {process_time}ms"
        )
        
        return response
