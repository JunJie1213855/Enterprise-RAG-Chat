FROM python:3.11-slim

WORKDIR /app

# System dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
# Vendored LightRAG is installed from source (not on a registry) *before*
# requirements.txt so our pins have the final say — otherwise LightRAG silently
# upgrades httpx/pydantic out from under the pinned openai SDK.
COPY requirements.txt .
COPY thirdparty/LightRAG ./thirdparty/LightRAG
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir ./thirdparty/LightRAG && \
    pip install --no-cache-dir -r requirements.txt

# Application code
COPY . .

# Create directories. Must exist *before* the chown below: a named volume
# mounted on an existing image directory inherits that directory's ownership,
# which is what lets the non-root appuser write to it.
RUN mkdir -p logs uploads lightrag_data

# Non-root user
RUN adduser --disabled-password --gecos "" appuser && \
    chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8000/api/v1/health || exit 1

# --workers MUST stay 1.
#
# The LightRAG knowledge graph is held in an in-process cache keyed by
# organization, backed by NetworkX files on disk. With more than one worker
# each process keeps its own copy, so a write in one worker is invisible to the
# other: identical requests would return different graphs (observed: node count
# alternating 206/211 between consecutive calls), and a delete performed by one
# worker would appear not to have happened when the next request landed on the
# other. Two processes writing the same NetworkX file is also unsafe.
#
# The app is I/O-bound (LLM and embedding calls), so a single async worker
# handles the load; scale by running more *hosts*, not more workers.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
