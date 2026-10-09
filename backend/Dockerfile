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

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
