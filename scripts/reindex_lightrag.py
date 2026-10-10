"""
Backfill the knowledge graph from documents already stored in Postgres.

Needed because the two retrieval stores are independent: switching
``RAG_BACKEND`` does not migrate anything. Documents indexed while the app ran
the vector-only path exist in ``documents``/``document_chunks`` but not in the
LightRAG graph, so ``hybrid`` would only ever see half the corpus.

    docker compose exec backend python scripts/reindex_lightrag.py
    docker compose exec backend python scripts/reindex_lightrag.py --org <uuid>
    docker compose exec backend python scripts/reindex_lightrag.py --dry-run

LightRAG de-duplicates by ``file_path``, so running this repeatedly is safe —
already-indexed documents are skipped. Each new document costs several LLM
calls for entity extraction, so expect this to take a while on a large corpus.
"""
import argparse
import asyncio
import logging
import sys
from pathlib import Path

# Make `app.*` importable both in the container (/app) and from the repo root.
_HERE = Path(__file__).resolve().parent
for _candidate in (_HERE.parent, _HERE.parent / "backend"):
    if (_candidate / "app").is_dir() and str(_candidate) not in sys.path:
        sys.path.insert(0, str(_candidate))

from loguru import logger  # noqa: E402

# DEBUG=true makes SQLAlchemy echo every statement — far too noisy for a CLI.
logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)

from sqlalchemy import select  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.db.session import AsyncSessionLocal  # noqa: E402
from app.models.chat import Document  # noqa: E402

DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001"


async def reindex(org_id: str, dry_run: bool) -> int:
    from app.rag.lightrag_retriever import LightRAGRetriever, get_engine

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Document)
            .where(
                Document.organization_id == org_id,
                Document.is_active.is_(True),
            )
            .order_by(Document.created_at)
        )
        documents = list(result.scalars().all())

    if not documents:
        logger.warning(f"No active documents for organization {org_id}")
        return 0

    # Same source ingested twice (CLI + web upload) collapses to one graph
    # entry, because LightRAG keys ingestion on file_path.
    unique_sources = {d.source or d.title for d in documents}
    logger.info(
        f"{len(documents)} document(s) in Postgres, {len(unique_sources)} unique source(s)"
    )

    if dry_run:
        for source in sorted(unique_sources):
            logger.info(f"  would index: {source}")
        return 0

    await get_engine(org_id)
    retriever = LightRAGRetriever()

    indexed = 0
    for i, doc in enumerate(documents, start=1):
        label = doc.source or doc.title
        try:
            count = await retriever.index_document(doc)
        except Exception as e:  # noqa: BLE001 - keep going, report at the end
            logger.error(f"FAIL  [{i}/{len(documents)}] '{label}': {e}")
            continue
        indexed += 1
        logger.info(f"OK    [{i}/{len(documents)}] '{label}' -> {count} chunk(s)")

    return indexed


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill the LightRAG knowledge graph from Postgres documents.",
    )
    parser.add_argument(
        "--org", default=DEFAULT_ORG_ID,
        help=f"Organization id (default: seeded org {DEFAULT_ORG_ID})",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="List what would be indexed without calling the LLM",
    )
    args = parser.parse_args()

    logger.info(
        f"Target graph: {settings.LIGHTRAG_DATA_DIR}/{args.org} "
        f"| LLM {settings.OPENAI_MODEL} | embeddings {settings.OPENAI_EMBEDDING_MODEL}"
    )
    indexed = asyncio.run(reindex(args.org, args.dry_run))
    logger.info(f"Done. {indexed} document(s) fed to the graph.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
