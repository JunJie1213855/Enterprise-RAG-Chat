# 架构说明

> 多租户 RAG 智能问答平台。前端 React，后端 FastAPI，检索层支持「向量检索」与「知识图谱检索」双实现，可配置切换。
>
> 本文描述**当前代码的真实状态**。最后更新：2026-10-08。

---

## 1. 服务拓扑

```
                      ┌──────────────────────────────┐
  浏览器 ──────────▶  │  frontend  (nginx:80 → :3000) │
                      │  · 静态资源                    │
                      │  · /api/ 反向代理 → backend    │
                      │  · proxy_buffering off (SSE)  │
                      └───────────────┬──────────────┘
                                      │ HTTP
                      ┌───────────────▼──────────────┐
                      │  backend  (uvicorn :8000 ×2) │
                      │  FastAPI 应用                  │
                      └───┬──────────────────┬───────┘
                          │                  │
              ┌───────────▼──────┐   ┌───────▼─────────────┐
              │ db (PostgreSQL16 │   │ redis:7             │
              │  + pgvector)     │   │ ⚠ 当前未被使用       │
              └──────────────────┘   └─────────────────────┘
                          │
                          │  外部 LLM / Embedding（OpenAI 兼容）
                          ▼
              ┌──────────────────────────┐
              │  agnes-ai   (LLM)        │
              │  SiliconFlow (bge-m3)    │
              └──────────────────────────┘
```

四个容器：`frontend` / `backend` / `db` / `redis`，由 `docker-compose.yml` 编排，均带 healthcheck，`backend` 依赖 `db`、`redis` 就绪后启动。

### 数据落盘位置

| 卷 | 内容 |
|---|---|
| `postgres_data` | 用户、会话、消息、文档、`document_chunks`（向量） |
| `backend_logs` / `backend_uploads` | 应用日志、上传文件 |
| `lightrag_data` | **知识图谱**及 LightRAG 的 kv/vector 文件，**每个 workspace 一个子目录** |
| `redis_data` | Redis AOF（当前无写入，见 §10） |

---

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 18 + Vite + TypeScript + Zustand + Tailwind **v4** + Sigma.js / graphology |
| 后端 | Python 3.11 + FastAPI 0.111 + SQLAlchemy 2.0 (async) + Pydantic 2 |
| 数据库 | PostgreSQL 16 + pgvector（HNSW 索引） |
| 图谱 | LightRAG 1.5.8（vendored，见 §5.3） |
| 模型接入 | `openai` SDK 3.26.1，指向任意 OpenAI 兼容端点 |
| 容器 | Docker Compose，非 root 用户运行 |

---

## 3. 目录结构

```
backend/app/
├── main.py                     # 应用装配、生命周期、路由注册
├── api/v1/
│   ├── auth.py                 # 注册 / 登录 / 刷新 / 当前用户
│   ├── chat.py                 # 对话（含 SSE 流式）、会话、文档
│   ├── graph.py                # 知识图谱查询
│   ├── admin.py                # 组织 / 用户 / 统计
│   └── health.py
├── core/
│   ├── config.py               # Pydantic Settings（全部配置项）
│   ├── security.py             # JWT、bcrypt
│   ├── dependencies.py         # get_current_user 等 DI
│   └── middleware.py           # 审计日志、request-id
├── db/session.py               # async engine + AsyncSessionLocal
├── models/                     # ORM：user.py / chat.py
├── schemas/                    # Pydantic 请求响应模型
├── services/                   # 业务逻辑：chat_service / user_service
└── rag/                        # ★ 检索与生成层，见 §5
    ├── base.py                 # Retriever 协议
    ├── factory.py              # 按 RAG_BACKEND 选实现
    ├── retriever.py            # 实现 A：pgvector 向量检索
    ├── lightrag_retriever.py   # 实现 B：LightRAG 图谱检索
    ├── ingest.py               # ★ 统一入库入口（双写）
    ├── parsers.py              # pdf/docx/md/txt → 纯文本
    ├── prompt.py               # 提示词拼装（两条链路共用）
    ├── embeddings.py           # Embedding 客户端
    └── llm_service.py          # LLM 客户端（含流式）

frontend/src/
├── App.tsx                     # 路由
├── pages/                      # Login / Register / Chat / Admin / Graph
├── components/                 # Sidebar / MessageBubble / ChatInput / RAGPanel
├── services/
│   ├── api.ts                  # axios 客户端（含 401 自动刷新）
│   └── stream.ts               # ★ fetch + ReadableStream 手写 SSE
├── store/                      # Zustand：authStore / chatStore
└── types/

scripts/
├── ingest.py                   # 批量导入 pdf/docx/md/txt
└── index_documents.py          # 重建索引
```

---

## 4. 请求链路

### 4.1 流式问答（主链路）

```
浏览器
  │ POST /api/v1/chat/stream   (fetch, Authorization 头, AbortController)
  ▼
backend  chat_stream()
  ├─ 建/取会话，保存用户提问，立即 commit
  │    （断开时请求作用域 session 可能不提交 → 先落盘，避免孤儿回答）
  └─ StreamingResponse(generate())
       │
       ├─ data: {"type":"session"}           ← 立刻返回，前端拿到 session_id
       ├─ data: {"type":"status","retrieving"}   ← 检索中（前端显示状态）
       ├─ [RAG 检索]                              ← 在流内执行，不阻塞首帧
       ├─ data: {"type":"context", ...}       ← 前端提前弹出"引用来源"面板
       ├─ data: {"type":"status","generating"}
       ├─ data: {"type":"token"} × N          ← 逐 token
       │    （空闲 >SSE_HEARTBEAT_SECONDS 时插入 `: ping` 注释帧）
       └─ data: {"type":"done"}
```

**三个关键实现点：**

1. **检索放在流内** —— 检索要先调一次 embedding（网络往返），放在流外会让首帧延迟 = 检索耗时。移入 generator 后，用户可以立刻看到"检索中"。
2. **心跳用 producer 任务 + `asyncio.Queue`** —— 超时只取消 `queue.get()`，**绝不取消底层 LLM 流**（直接包 `wait_for` 会破坏 httpx 流）。
3. **断连时用 `asyncio.shield` 落库** —— 任务被取消时 `finally` 里的 `await` 会被**立即再次取消**，写库代码根本不会执行。shield 让写入在后台完成，实现"停止生成不丢数据"。

### 4.2 前端为什么不用 `EventSource`

原生 `EventSource` 有三个硬限制，全部命中：**只能 GET**、**不能带 `Authorization` 头**、**无法取消**。因此 `services/stream.ts` 用 `fetch` + `ReadableStream` 手写帧解析：

- 按 `\n\n` 切帧，buffer 跨 chunk 累积（一个 chunk 可能含多帧，一帧也可能跨 chunk）
- 401 时刷新 token 并重试一次（axios 拦截器管不到 fetch）
- 心跳注释帧（`: ping`）自动跳过

> ⚠️ nginx 必须 `proxy_buffering off`，否则整个流会被缓冲，前端表现为"等全部生成完才一次性出现"。

---

## 5. 检索层（核心）

### 5.1 抽象与双链路

```
                    ┌───────────────┐
                    │  Retriever 协议 │  retrieve(query, org_id, k) -> List[RAGContext]
                    └───────┬───────┘
                            │  factory.get_retriever()
            ┌───────────────┴───────────────┐
            ▼                               ▼
   RAGRetriever (legacy)          LightRAGRetriever
   ─ pgvector 余弦检索             ─ 知识图谱检索
   ─ CJK 感知分块                  ─ LightRAG token 级分块
   ─ 内存中分块+向量化              ─ LLM 抽取实体/关系
                                   ─ aquery_data(mode=hybrid)
```

由 `RAG_BACKEND=legacy|lightrag` 切换。**两条链路返回同一个 `RAGContext`**，所以上层（提示词拼装、SSE、前端）完全无感知 —— 这也是能做 A/B 对比的前提。

### 5.2 实现 A：pgvector 向量检索

```
文档 → parsers 抽文本 → TextChunker 分块 → embedding → document_chunks(vector 1024)
查询 → embedding → 余弦相似度 top-k（org + is_active 前置过滤）→ RAGContext
```

`TextChunker` 是 **CJK 感知**的：中文按**字符**打包（≥10% 中日韩字符走此路径），英文按**词**。原因是中文没有空格，按词计数会把整篇文档坍缩成一块，块内 embedding 被平均稀释，具体问题的相似度会掉到阈值以下。

### 5.3 实现 B：LightRAG 知识图谱

LightRAG 以 **vendored 方式**放在 `backend/thirdparty/LightRAG`，Docker 构建时从源码安装。**只使用它的图谱层**：

| 用途 | 用到的能力 |
|---|---|
| 文本处理 | LightRAG 的 token 级分块器（tiktoken，天然适配中文） |
| 图谱构建 | `extract_entities` → 实体/关系 → 存储 |
| 图谱检索 | `aquery_data(mode=hybrid)` —— **只检索不生成** |
| 生成 | ❌ 不用。仍由本项目的 `llm_service` 负责，以保留流式与统一 provider 配置 |

`aquery_data` 返回结构化的 `entities / relationships / chunks`，其中 `chunks` 映射为 `RAGContext`。

> 相似度分数字段对图谱路径是**排名代理值**（`1 - rank*0.01`），不是余弦相似度 —— 两者不可直接比较，可比的只有"正确文档是否排第 1"。

### 5.4 统一入库入口与双写

```
index_document(document, db, background)
  ├─ 1. 写主链路（按 RAG_BACKEND）
  └─ 2. LIGHTRAG_INDEX_ALWAYS 且主链路非 lightrag → 镜像写图谱
```

- **API 走 `BackgroundTasks`**：图谱抽取一份文档要多次 LLM 调用（数秒到数分钟），同步会阻塞上传接口
- **CLI 脚本同步**：批量工具，等得起
- **图谱失败不影响入库**：`DocumentSnapshot` 把字段从 ORM 实例快照下来（后台任务执行时 DB session 可能已关闭），镜像失败只记 ERROR 日志并说明后果
- 主链路本身就是 lightrag 时不重复写

### 5.5 文档解析

`parsers.py` 统一把 pdf / docx / md / txt 转纯文本：

- **PDF**：`PyMuPDF` 主 + `pypdf` 兜底。PyMuPDF 能通过字形名反查恢复**缺失 `/ToUnicode` CMap** 的中文 PDF（LaTeX 生成的 CJK PDF 常见），pypdf 对这类文件只会输出乱码
- **DOCX**：`python-docx`，段落 + 表格展平
- **空内容即失败**：不产生空文档污染知识库；扫描件会得到明确的"需要 OCR"提示

---

## 6. 数据模型

```
organizations ──┬── users ──── chat_sessions ──── messages
                │
                └── documents ──── document_chunks (embedding vector(1024))
```

**多租户隔离**：`organization_id` 贯穿所有业务表；检索在 SQL 里**前置过滤** `organization_id` 与 `is_active`，杜绝跨租户召回。对应到图谱，`organization_id` 直接作为 LightRAG 的 `workspace`。

> ⚠️ `EMBEDDING_DIMENSION` 必须与**三处**一致：`.env`、`models/chat.py` 的 `Vector(...)`、`database/init.sql` 的 `vector(N)`。不一致会**静默写入失败**（只在运行时报错，不报在启动时）。

---

## 7. API 一览

前缀 `/api/v1`，除 health/auth 外均需 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（含 DB 连通性、LLM/Embedding 配置状态） |
| POST | `/auth/register` `/auth/login` `/auth/refresh` `/auth/logout` | 认证 |
| GET | `/auth/me` | 当前用户 |
| POST | `/chat/` | 对话（非流式） |
| POST | `/chat/stream` | **对话（SSE 流式）** |
| GET/PATCH/DELETE | `/chat/sessions[/{id}]` | 会话管理 |
| POST | `/chat/documents` | 粘贴文本入库 |
| POST | `/chat/documents/upload` | **文件上传入库**（pdf/docx/md/txt，multipart） |
| GET/DELETE | `/chat/documents[/{id}]` | 文档列表 / 软删除 |
| GET | `/chat/graph` | **知识图谱**（`label` / `max_depth` / `max_nodes`） |
| GET | `/admin/stats` `/admin/users` `/admin/organization` | 管理端（需 admin 角色） |

---

## 8. 前端

| 路由 | 页面 |
|---|---|
| `/login` `/register` | 认证 |
| `/chat` `/chat/:sessionId` | 对话（流式渲染、停止生成、引用来源面板） |
| `/graph` | **知识图谱可视化** |
| `/admin` | 管理面板（admin 角色） |

**图谱可视化**用 Sigma.js v3（WebGL）+ graphology：

- 布局：**同步 ForceAtlas2 跑到收敛**（而非 worker 异步）。几十个节点的同步布局只需 ~100ms，换来"布局必然收敛、相机必然框对"的确定性
- 初始位置**环形撒点**（半径随节点数伸缩）—— 随机撒在 `[0,1]` 小方框里会让节点挤成一坨
- `adjustSizes: true` 让节点尺寸参与布局，避免 hub 压住邻居
- 配色沿用 LightRAG 的调色板，节点大小按度数

> 模态框一律用 `createPortal` 挂到 `body`：侧栏有 `backdrop-blur`，会成为 `position: fixed` 后代的**包含块**，导致全屏遮罩被限制在 256px 宽的侧栏内。

---

## 9. 关键配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `RAG_BACKEND` | `legacy` | `legacy`（pgvector）/ `lightrag`（图谱） |
| `LIGHTRAG_INDEX_ALWAYS` | `true` | 非 lightrag 链路时是否镜像写图谱 |
| `LIGHTRAG_QUERY_MODE` | `hybrid` | `local` / `global` / `hybrid` / `mix` / `naive` |
| `SSE_HEARTBEAT_SECONDS` | `15` | SSE 心跳间隔；代理超时更短时调小 |
| `RAG_SIMILARITY_THRESHOLD` | `0.5` | **按 embedding 模型调**：OpenAI ~0.7，bge-m3 ~0.5 |
| `EMBEDDING_DIMENSION` | `1024` | 必须与 ORM 和 DDL 三处一致 |
| `LLM_BASE_URL` / `LLM_API_KEY` | — | 对话模型端点；留空回退到 `OPENAI_*` |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` | — | 向量模型端点，可与 LLM 不同供应商 |
| `MAX_UPLOAD_SIZE_MB` | `10` | 应用层上限；nginx 的 `client_max_body_size` 设得更高，让后端返回规范 JSON 错误 |

---

## 10. 已知约束与设计权衡

**依赖版本陷阱（改动时务必回归）**
LightRAG 的 `google-genai` 依赖强制 `httpx>=0.28.1`，而 `openai<2` 的 `AsyncHttpxClientWrapper` 在 httpx 0.28 下会崩（`AttributeError: _state`）。因此 `openai` 必须 ≥3.x。Dockerfile 中 **LightRAG 在 requirements 之前安装**，让本项目的 pin 拥有最终决定权。

**图谱是派生数据**
图谱写入失败不影响主链路（文档仍可检索），代价是图与知识库可能短暂不一致。Graph 页面在 `RAG_BACKEND=legacy` 且 `LIGHTRAG_INDEX_ALWAYS=false` 时不会增长。

**图谱实体名为英文**
LightRAG 的实体归一化会把中文实体转成英文（`张伟` → `Zhang Wei`）。若要显示中文实体名，需调整抽取提示词或加名称映射层。

**Redis 是运行着的，但代码里没用**
`REDIS_URL` 有配置、容器也正常启动，但全仓库没有任何一处 import redis。限流实际由 **slowapi 的内存存储**处理，且额度**硬编码在装饰器里**：

| 端点 | 实际限流 |
|---|---|
| `POST /chat/` | `30/minute` |
| `POST /chat/stream` | `20/minute` |
| `POST /auth/login` | `10/hour` |
| `POST /auth/register` | `20/hour` |

因此 `.env` 里的 `RATE_LIMIT_PER_MINUTE` / `_PER_HOUR` / `_PER_DAY` 三个配置项**只是定义了、没有被引用**，改了不生效。另外因为 `uvicorn --workers 2`，内存限流是**按进程**计数的，跨 worker 不共享配额（真实上限约为标注值的 2 倍，且分布不均）。要真正生效需把 slowapi 的 `storage_uri` 指向 Redis，并把限额改成从 settings 读取。

**软删除的可见性**
`is_active=false` 的文档会**静默退出检索**。若前端列表仍展示它，用户会以为它还在 —— 这是当前的一个待改进点。

**尚未实现**
- 独立的压测报告（QPS / P95 / TTFT 基线）
- 检索质量评测集与自动化回归
- `.env` 尚未纳入密钥轮换流程
