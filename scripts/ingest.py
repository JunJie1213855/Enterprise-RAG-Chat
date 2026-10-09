"""
Bulk-ingest documents (pdf / docx / md / txt) into the knowledge base.

Runs inside the backend container, which already has the DB, embeddings
and parsing libraries available:

    # 1. drop files into ./documents on the host, then:
    docker compose exec backend python scripts/ingest.py /app/documents

    # a single file, with an explicit title
    docker compose exec backend python scripts/ingest.py /app/documents/manual.pdf --title "产品手册"

    # whole tree, re-index files that were already imported
    docker compose exec backend python scripts/ingest.py /app/documents --recursive --force

Files are de-duplicated by source path: a file already imported under the
same path is skipped unless --force is given.
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

# DEBUG=true makes the engine echo every statement — far too noisy for a CLI.
logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

from app.core.config import settings  # noqa: E402
from app.db.session import AsyncSessionLocal  # noqa: E402
from app.models.chat import Document  # noqa: E402
from app.rag.parsers import (  # noqa: E402
    SUPPORTED_EXTENSIONS,
    DocumentParseError,
    extract_text,
    supported_extensions,
)
from app.rag.ingest import index_document  # noqa: E402
from sqlalchemy import select  # noqa: E402

# Organization that owns the imported documents. Defaults to the seeded org.
DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001"


def collect_files(paths: list[str], recursive: bool) -> tuple[list[Path], list[Path]]:
    """Return (supported files, skipped-extension files) for the given inputs."""
    found: list[Path] = []
    skipped: list[Path] = []

    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            pattern = "**/*" if recursive else "*"
            for child in sorted(p.glob(pattern)):
                if child.is_file():
                    (found if child.suffix.lower() in SUPPORTED_EXTENSIONS else skipped).append(child)
        elif p.is_file():
            (found if p.suffix.lower() in SUPPORTED_EXTENSIONS else skipped).append(p)
        else:
            logger.warning(f"Skipping '{raw}': no such file or directory")
            skipped.append(p)

    return found, skipped


async def ingest(
    paths: list[str],
    org_id: str,
    recursive: bool,
    force: bool,
    title: str | None,
) -> int:
    """Ingest every supported file. Returns the number of files indexed."""
    files, skipped = collect_files(paths, recursive)

    if skipped:
        logger.info(f"Skipped {len(skipped)} unsupported/missing path(s)")
    if not files:
        logger.warning(
            f"Nothing to ingest. Supported extensions: {', '.join(supported_extensions())}"
        )
        return 0

    logger.info(f"Found {len(files)} file(s) to ingest")
    indexed = 0

    async with AsyncSessionLocal() as db:

        for path in files:
            source = str(path.resolve())
            doc_title = title or path.stem

            # De-duplicate on source path.
            existing = await db.execute(
                select(Document).where(
                    Document.source == source,
                    Document.organization_id == org_id,
                )
            )
            prior = existing.scalars().first()

            if prior and not force:
                logger.info(f"SKIP  '{doc_title}' (already imported: {prior.id})")
                continue
            if prior and force:
                await db.delete(prior)
                await db.flush()
                logger.info(f"REPLACE '{doc_title}' (--force)")

            try:
                text = extract_text(path)
            except DocumentParseError as e:
                logger.error(f"FAIL  '{path.name}': {e}")
                continue

            doc = Document(
                organization_id=org_id,
                title=doc_title,
                content=text,
                source=source,
                doc_type=path.suffix.lstrip(".").lower(),
            )
            db.add(doc)
            await db.flush()
            await db.refresh(doc)

            try:
                chunk_count = await index_document(doc, db)
            except Exception as e:
                await db.rollback()
                logger.error(f"FAIL  '{doc_title}': indexing error: {e}")
                continue

            await db.commit()
            indexed += 1
            logger.info(
                f"OK    '{doc_title}' [{doc.doc_type}] "
                f"{len(text)} chars -> {chunk_count} chunk(s)"
            )

    return indexed


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Ingest pdf/docx/md/txt files into the RAG knowledge base.",
    )
    parser.add_argument("paths", nargs="+", help="Files or directories to ingest")
    parser.add_argument(
        "-r", "--recursive", action="store_true", help="Recurse into subdirectories"
    )
    parser.add_argument(
        "-f", "--force", action="store_true",
        help="Re-index files that were already imported (replaces the old document)",
    )
    parser.add_argument(
        "--title", default=None,
        help="Force a title (only sensible when ingesting a single file)",
    )
    parser.add_argument(
        "--org", default=DEFAULT_ORG_ID,
        help=f"Organization id that owns the documents (default: seeded org {DEFAULT_ORG_ID})",
    )
    args = parser.parse_args()

    if args.title and len(args.paths) > 1:
        parser.error("--title is only valid with a single input path")

    logger.info(f"Embedding model: {settings.OPENAI_EMBEDDING_MODEL} "
                f"({settings.EMBEDDING_DIMENSION} dims) via {settings.embedding_base_url}")

    indexed = asyncio.run(
        ingest(args.paths, args.org, args.recursive, args.force, args.title)
    )

    logger.info(f"Done. {indexed} document(s) indexed.")
    return 0 if indexed else 1


if __name__ == "__main__":
    sys.exit(main())
