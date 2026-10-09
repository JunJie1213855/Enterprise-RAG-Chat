"""
Script to re-index all documents in the knowledge base.
Run this after adding new documents via the admin panel or directly in the DB.

Usage: python scripts/index_documents.py
"""
import asyncio
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from app.db.session import AsyncSessionLocal
from app.models.chat import Document
from app.rag.factory import get_retriever
from sqlalchemy import select
from loguru import logger


async def index_all():
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Document).where(Document.is_active == True))
        docs = list(result.scalars().all())
        logger.info(f"Found {len(docs)} documents to index")

        retriever = get_retriever(db)
        total_chunks = 0

        for doc in docs:
            count = await retriever.index_document(doc)
            total_chunks += count
            logger.info(f"  Indexed '{doc.title}': {count} chunks")

        await db.commit()
        logger.info(f"Done. Total chunks: {total_chunks}")


if __name__ == "__main__":
    asyncio.run(index_all())
