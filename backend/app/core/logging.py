"""
Logging configuration using Loguru
"""
import sys
import os
from loguru import logger
from app.core.config import settings


def setup_logging():
    """Configure application logging."""
    logger.remove()
    
    # Console logging
    logger.add(
        sys.stdout,
        level=settings.LOG_LEVEL,
        format=(
            "<green>{time:YYYY-MM-DD HH:mm:ss}</green> | "
            "<level>{level: <8}</level> | "
            "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> | "
            "<level>{message}</level>"
        ),
        colorize=True,
    )
    
    # File logging
    os.makedirs("logs", exist_ok=True)
    logger.add(
        settings.LOG_FILE,
        level=settings.LOG_LEVEL,
        format=(
            "{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | "
            "{name}:{function}:{line} | {message}"
        ),
        rotation="10 MB",
        retention="30 days",
        compression="zip",
    )
    
    logger.info("Logging configured successfully")
