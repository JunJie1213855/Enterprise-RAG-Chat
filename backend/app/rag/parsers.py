"""
Document text extraction — turns uploaded / on-disk files into plain text.

Supported formats (text-based only, no OCR):
    .pdf   -> pypdf
    .docx  -> python-docx
    .md    -> read as-is (Markdown is passed through; the LLM handles it)
    .txt   -> read as-is

Scanned / image-only PDFs will yield little or no text — callers get a
DocumentParseError rather than a silent empty document.
"""
from pathlib import Path
from typing import Union

from loguru import logger

# Extension -> human label, used for validation and error messages.
SUPPORTED_EXTENSIONS: dict[str, str] = {
    ".pdf": "PDF",
    ".docx": "Word",
    ".md": "Markdown",
    ".markdown": "Markdown",
    ".txt": "Text",
}


class DocumentParseError(ValueError):
    """Raised when a file cannot be turned into usable text."""


def is_supported(filename: str) -> bool:
    return Path(filename).suffix.lower() in SUPPORTED_EXTENSIONS


def supported_extensions() -> list[str]:
    return sorted(SUPPORTED_EXTENSIONS)


def extract_text_from_bytes(filename: str, data: bytes) -> str:
    """Extract plain text from raw file bytes.

    Raises DocumentParseError for unsupported formats, unreadable files
    and documents that yield no text.
    """
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise DocumentParseError(
            f"Unsupported file type '{suffix or filename}'. "
            f"Supported: {', '.join(supported_extensions())}"
        )

    if not data:
        raise DocumentParseError(f"'{filename}' is empty")

    if suffix == ".pdf":
        text = _extract_pdf(data, filename)
    elif suffix == ".docx":
        text = _extract_docx(data, filename)
    else:  # .md / .markdown / .txt
        text = _extract_plain(data, filename)

    text = text.strip()
    if not text:
        raise DocumentParseError(
            f"No text could be extracted from '{filename}'. "
            "If it is a scanned/image-only document, OCR is required."
        )
    return text


def extract_text(path: Union[str, Path]) -> str:
    """Extract plain text from a file on disk."""
    p = Path(path)
    if not p.is_file():
        raise DocumentParseError(f"Not a file: {p}")
    return extract_text_from_bytes(p.name, p.read_bytes())


# ----------------------------------------------------------------------
# Format-specific extractors
# ----------------------------------------------------------------------
def _extract_plain(data: bytes, filename: str) -> str:
    """UTF-8 first, falling back to a lenient decode for legacy encodings."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        logger.warning(f"'{filename}' is not valid UTF-8; decoding with errors='replace'")
        return data.decode("utf-8", errors="replace")


def _extract_pdf(data: bytes, filename: str) -> str:
    """PyMuPDF first, pypdf as fallback.

    PyMuPDF recovers text from CID fonts that ship no /ToUnicode CMap (common
    in LaTeX-generated CJK PDFs) by reverse-mapping glyph names. pypdf returns
    mojibake for those, so it is only a fallback for files PyMuPDF cannot open.
    """
    try:
        text = _extract_pdf_mupdf(data, filename)
    except DocumentParseError:
        raise
    except Exception as e:
        logger.warning(f"PyMuPDF failed on '{filename}' ({e}); falling back to pypdf")
        text = ""

    if text.strip():
        return text

    logger.warning(f"PyMuPDF produced no text for '{filename}'; falling back to pypdf")
    return _extract_pdf_pypdf(data, filename)


def _extract_pdf_mupdf(data: bytes, filename: str) -> str:
    import pymupdf

    try:
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            if doc.needs_pass:
                raise DocumentParseError(f"'{filename}' is password-protected")
            return "\n\n".join(page.get_text() for page in doc)
    except DocumentParseError:
        raise
    except Exception as e:
        raise DocumentParseError(f"Failed to read PDF '{filename}': {e}") from e


def _extract_pdf_pypdf(data: bytes, filename: str) -> str:
    from io import BytesIO

    from pypdf import PdfReader

    try:
        reader = PdfReader(BytesIO(data))
        if reader.is_encrypted:
            # Try the common empty-password case before giving up.
            try:
                reader.decrypt("")
            except Exception:
                raise DocumentParseError(f"'{filename}' is password-protected")

        pages = []
        for i, page in enumerate(reader.pages, start=1):
            try:
                pages.append(page.extract_text() or "")
            except Exception as e:
                logger.warning(f"'{filename}' page {i} failed to extract: {e}")
        return "\n\n".join(pages)
    except DocumentParseError:
        raise
    except Exception as e:
        raise DocumentParseError(f"Failed to read PDF '{filename}': {e}") from e


def _extract_docx(data: bytes, filename: str) -> str:
    from io import BytesIO

    from docx import Document

    try:
        doc = Document(BytesIO(data))
        parts = [p.text for p in doc.paragraphs if p.text.strip()]
        # Tables carry real content in most specs — flatten them row by row.
        for table in doc.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells if c.text.strip()]
                if cells:
                    parts.append(" | ".join(cells))
        return "\n".join(parts)
    except Exception as e:
        raise DocumentParseError(f"Failed to read Word document '{filename}': {e}") from e
