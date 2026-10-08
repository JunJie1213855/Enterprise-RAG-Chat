# 🤖 Enterprise Chatbot — RAG-Powered SaaS Platform

A production-ready enterprise chatbot system built on a **Retrieval-Augmented Generation (RAG)** architecture, with multi-tenant SaaS support, JWT authentication, a React frontend, and a FastAPI backend.

---

## 📐 Architecture Overview

```
┌─────────────────┐     ┌──────────────────────┐     ┌────────────┐
│   React + Vite  │────▶│  FastAPI Backend      │────▶│ PostgreSQL │
│   Tailwind CSS  │     │  RAG Pipeline         │     │ pgvector   │
│   Zustand       │     │  JWT Auth             │     └────────────┘
└─────────────────┘     │  Rate Limiting        │     ┌────────────┐
                        │  Multi-tenant         │────▶│   Redis    │
                        └──────────────────────┘     └────────────┘
                                   │
                                   ▼
                         ┌──────────────────┐
                         │   OpenAI API     │
                         │  GPT-4o / Embed  │
                         └──────────────────┘
```

### RAG Flow

```
User Query
    │
    ▼
Embed Query (text-embedding-3-small)
    │
    ▼
pgvector Cosine Similarity Search (top-k chunks)
    │
    ▼
Inject Context into System Prompt
    │
    ▼
LLM Generation (GPT-4o)
    │
    ▼
Streamed/Buffered Response → User
```

---

## 🗂️ Project Structure

```
enterprise-chatbot/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app entry point
│   │   ├── api/v1/
│   │   │   ├── auth.py          # Register, login, refresh, me
│   │   │   ├── chat.py          # Chat, sessions, documents
│   │   │   ├── admin.py         # Admin: users, stats, org
│   │   │   └── health.py        # Health check
│   │   ├── core/
│   │   │   ├── config.py        # Pydantic settings
│   │   │   ├── security.py      # JWT, bcrypt
│   │   │   ├── middleware.py    # Audit log, request ID
│   │   │   └── dependencies.py  # FastAPI DI: auth, DB
│   │   ├── db/session.py        # SQLAlchemy async engine
│   │   ├── models/              # ORM models
│   │   ├── schemas/             # Pydantic schemas
│   │   ├── services/            # Business logic
│   │   └── rag/
│   │       ├── embeddings.py    # OpenAI embedding service
│   │       ├── retriever.py     # pgvector RAG pipeline
│   │       └── llm_service.py   # OpenAI chat completions
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── pages/               # LoginPage, RegisterPage, ChatPage, AdminPage
│   │   ├── components/          # Sidebar, MessageBubble, ChatInput, RAGPanel
│   │   ├── store/               # Zustand: authStore, chatStore
│   │   ├── services/api.ts      # Axios API client
│   │   └── types/index.ts       # TypeScript types
│   ├── package.json
│   └── Dockerfile
├── database/init.sql            # Schema + seed data
├── docker-compose.yml
├── .env.example
├── scripts/
│   ├── start.bat                # Windows one-click start
│   ├── stop.bat
│   └── index_documents.py       # Re-index knowledge base
└── README.md
```

---

## ⚡ Quick Start (Docker — Recommended)

### Prerequisites

- [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop) (v4+)
- An [OpenAI API key](https://platform.openai.com/api-keys) (optional — demo mode works without one)

### Steps

```bat
# 1. Clone / extract the project
cd enterprise-chatbot

# 2. Copy environment file
copy .env.example .env

# 3. Add your OpenAI key in .env (optional but recommended)
#    OPENAI_API_KEY=sk-...

# 4. Start everything (Windows)
scripts\start.bat

# OR manually
docker compose up --build -d
```

After ~60 seconds:

| Service  | URL |
|----------|-----|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:8000 |
| API Docs (Swagger) | http://localhost:8000/api/docs |

**Default admin credentials:** `admin@example.com` / `Admin@123`

---

## 🔧 Manual Setup (No Docker)

### Backend

```bash
cd backend

# Create virtualenv
python -m venv venv
venv\Scripts\activate       # Windows
# source venv/bin/activate  # Linux/Mac

pip install -r requirements.txt

# Set up PostgreSQL (with pgvector extension)
# Update DATABASE_URL in .env

uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev        # Dev server on http://localhost:5173
npm run build      # Production build
```

---

## 🌍 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key | *(demo mode if empty)* |
| `OPENAI_MODEL` | Chat model | `gpt-4o` |
| `OPENAI_EMBEDDING_MODEL` | Embedding model | `text-embedding-3-small` |
| `DATABASE_URL` | PostgreSQL async URL | *(set by docker-compose)* |
| `JWT_SECRET_KEY` | JWT signing secret | **Change in production!** |
| `SECRET_KEY` | App secret | **Change in production!** |
| `RAG_TOP_K` | Retrieved chunks per query | `5` |
| `RAG_SIMILARITY_THRESHOLD` | Min cosine similarity | `0.65` |
| `RATE_LIMIT_PER_MINUTE` | Requests/min per IP | `30` |

---

## 📡 API Reference

### Authentication

```http
POST /api/v1/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "username": "johndoe",
  "password": "SecurePass1",
  "full_name": "John Doe",
  "organization_name": "Acme Corp"
}
```

```http
POST /api/v1/auth/login
{
  "email": "user@example.com",
  "password": "SecurePass1"
}
# Returns: { access_token, refresh_token, token_type, expires_in }
```

### Chat

```http
POST /api/v1/chat/
Authorization: Bearer <token>

{
  "message": "What products do you offer?",
  "session_id": null,
  "use_rag": true
}
```

### Knowledge Base

```http
POST /api/v1/chat/documents
Authorization: Bearer <token>

{
  "title": "Product Manual",
  "content": "Full document text here...",
  "doc_type": "text"
}
```

### Admin

```http
GET /api/v1/admin/stats       # Org statistics
GET /api/v1/admin/users       # List users
PATCH /api/v1/admin/users/{id}/role?role=admin
DELETE /api/v1/admin/users/{id}  # Deactivate
```

---

## 🔐 Security Features

- **JWT authentication** with access + refresh tokens
- **bcrypt password hashing** (cost factor 12)
- **Rate limiting** via SlowAPI (per IP, per minute/hour)
- **Input validation** via Pydantic
- **SQL injection protection** via SQLAlchemy ORM
- **CORS** configured per environment
- **Audit logging** on all requests
- **Non-root Docker containers**
- **Environment-based secret management**

---

## 🏗️ Multi-Tenant Architecture

- Each **Organization** has isolated:
  - Users (with roles: admin / member / viewer)
  - Chat sessions & messages
  - Knowledge base documents & embeddings
- RAG retrieval is **scoped to the organization**
- Admin panel is **role-gated**

---

## 📦 Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, Tailwind CSS, Zustand |
| Backend | Python 3.11, FastAPI, SQLAlchemy 2.0 |
| Database | PostgreSQL 16 + pgvector |
| Cache | Redis 7 |
| Embeddings | OpenAI text-embedding-3-small |
| LLM | OpenAI GPT-4o |
| Auth | JWT (python-jose) + bcrypt (passlib) |
| Containerization | Docker + Docker Compose |

---

## 🐛 Troubleshooting

**Port already in use:**
```bat
docker compose down
docker compose up --build -d
```

**Database connection errors:**
```bat
docker compose logs db
# Wait for "database system is ready to accept connections"
```

**pgvector not available:**
The project uses `pgvector/pgvector:pg16` Docker image which includes pgvector. If running locally, install the extension manually.

**No AI responses (demo mode):**
Add `OPENAI_API_KEY=sk-...` to your `.env` file and restart.

---

## 📄 License

MIT — free to use and modify for commercial and personal projects.
