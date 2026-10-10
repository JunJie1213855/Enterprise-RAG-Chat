# 学习指南

> 怎么读懂这个项目。**后端优先**，前端待补。
>
> 配套：[architecture.md](./architecture.md)（系统全貌）。本文回答的是「**按什么顺序读、每步该懂什么**」。

---

## 0. 先读这一页：学习方法

**不要按目录顺序啃。** `models/` → `schemas/` → `services/` 这种读法，读完你记住了名词，但不知道系统怎么运转。

**正确姿势：跟着一个请求走完整条链路**，走到哪读到哪。遇到不认识的调用就跳进去，跳不动就标个 TODO 继续走。走完一趟，再走第二趟 —— 第二趟你会发现之前跳过的都看懂了。

**每一步都用 Swagger 打一次接口。** 这个项目的价值一半在代码、一半在"它真的能跑"。脱离运行时读代码，你会丢掉大量判断依据（比如"这个阈值到底合不合适"）。

后端总共 **3136 行**，规模不大，值得精读。

---

## 1. 地图

| 文件 | 行数 | 优先级 | 说明 |
|---|---|---|---|
| `app/main.py` | ~118 | ⭐⭐⭐ 必读 | 应用装配、生命周期、路由挂载 |
| `app/core/config.py` | ~125 | ⭐⭐⭐ 必读 | 全部配置项 |
| `app/api/v1/chat.py` | 532 | ⭐⭐⭐ 精读 | 项目的心脏 |
| `app/rag/retriever.py` | 263 | ⭐⭐⭐ 精读 | 向量检索 + 中文分块 |
| `app/rag/lightrag_retriever.py` | ~261 | ⭐⭐ 进阶 | 图谱检索 |
| `app/rag/ingest.py` | 84 | ⭐⭐ 进阶 | 统一入库入口（双写） |
| `app/rag/parsers.py` | 171 | ⭐⭐ | PDF/Word 文本抽取 |
| `app/services/chat_service.py` | 167 | ⭐⭐ | 会话与消息的持久化 |
| `app/models/*.py` | ~180 | ⭐⭐ | 表结构 |
| `app/schemas/*.py` | ~186 | ⭐ | 请求/响应契约 |
| `app/api/v1/auth.py` | 152 | ⭐ | 认证 |
| `app/core/dependencies.py` | 82 | ⭐⭐ | 依赖注入 |
| `app/rag/llm_service.py` | 107 | ⭐⭐ | LLM 客户端 |
| `app/rag/embeddings.py` | 75 | ⭐ | Embedding 客户端 |
| `app/rag/prompt.py` | 44 | ⭐ | 提示词拼装 |
| `app/api/v1/admin.py` | 125 | — | 可跳过 |

**别读** `thirdparty/LightRAG/` —— 147 MB 的第三方库。只需要知道它对外暴露什么（读 `lightrag_retriever.py` 即可）。

---

## 2. 阶段一：骨架 —— 应用怎么装起来的

**目标**：一个 HTTP 请求进来，依次经过哪些中间件？

**读 `app/main.py`（118 行，全读）**
- 第 24 行 `lifespan` —— 启动和关闭时各做什么
- 第 53 行 `FastAPI(lifespan=...)` —— 应用是怎么构造的
- 第 82 / 92 行 —— 两个中间件与全局异常处理
- 第 105–109 行 `include_router` —— **五个路由前缀**，这是你的 API 地图

**读 `app/core/config.py`（125 行，全读）**
- 第 93 行起那几个 `@property`（`llm_base_url` / `llm_api_key` / `embedding_base_url` / ...）—— **这是"LLM 和 Embedding 可以用不同供应商"的实现**，是理解整个配置体系的钥匙

> ### ✅ 自测
> 1. `/api/v1/chat/graph` 这个路由是谁注册的？
> 2. `LLM_BASE_URL` 留空时，实际会用哪个地址？
> 3. `DEBUG=true` 会影响什么？

---

## 3. 阶段二：数据层 —— 表结构决定一切

**目标**：数据怎么存的，多租户隔离靠什么实现？

| 文件 | 读什么 |
|---|---|
| `app/models/chat.py` | `Document` / `DocumentChunk` / `ChatSession` / `Message` |
| `app/models/user.py` | `User` / `Organization` |
| `app/db/session.py` | async engine、`get_db` 依赖 |
| `app/schemas/chat.py` | 请求/响应模型（和 ORM 是**两套**，别混） |

**两个必须看懂的细节**
1. `DocumentChunk.embedding` 的类型是 `Vector(settings.EMBEDDING_DIMENSION)`，而 `database/init.sql` 里是 `vector(1024)`。**这两处加上 `.env` 的 `EMBEDDING_DIMENSION`，必须三者一致** —— 不一致会在写入时静默失败。
2. `metadata_` 这个字段名（带下划线）—— 因为 `metadata` 是 SQLAlchemy 的保留名。

> ### ✅ 自测
> 1. 删除一个 organization，它的 documents 会被怎么处理？看 `ForeignKey` 的 `ondelete`
> 2. `get_db` 里的 `commit()` 在什么时候执行？如果请求抛异常呢？
> 3. 为什么请求和响应用两套模型，而不是直接返回 ORM 对象？

---

## 4. 阶段三：跟一个最简单的请求走完

**目标**：建立主框架，此时把 RAG 当黑盒。

### 第一趟：`POST /api/v1/auth/login`

读 `app/api/v1/auth.py`（152 行）：

```
路由 → Pydantic 校验 → user_service.authenticate_user
     → core/security.verify_password → 签发 JWT → 返回
```

顺带看 `app/core/dependencies.py` 的 `get_current_user` —— 后面所有受保护接口都靠它。

### 第二趟：`POST /api/v1/chat/`（非流式）

读 `app/api/v1/chat.py` 的 **`chat()`（第 122–201 行）**，就 80 行，按注释的数字走：

```
1 建/取会话 → 2 检索 → 3 读历史 → 4 拼提示词
→ 5 存用户消息 → 6 调 LLM → 7 存回答 → 返回
```

碰到 `get_retriever()` 和 `build_augmented_prompt()` **当黑盒跳过**。

> ### ✅ 自测
> 1. 用户消息是在调 LLM **之前**还是之后落库的？为什么这个顺序重要？
> 2. `use_rag=false` 时，代码走了哪些不同分支？
> 3. LLM 调用失败时返回什么状态码？为什么不是 500？

---

## 5. 阶段四：RAG 层 —— 项目的核心价值

**按这个顺序读**，每一层只依赖前一层：

```
1. app/rag/base.py              (协议，几分钟看完)
2. app/rag/embeddings.py        (75 行，怎么调 embedding)
3. app/rag/llm_service.py       (107 行，怎么调 LLM，注意 stub 降级)
4. app/rag/prompt.py            (50 行，提示词怎么拼)
5. app/rag/retriever.py         (263 行) ★ 精读
6. app/rag/factory.py           (选实现，三种模式)
7. app/rag/hybrid_retriever.py  (RRF 融合，默认模式) ★
```

### `retriever.py` 两个高价值段落

**① `TextChunker`（第 30–101 行）—— 中文分块**

- 第 42 行 `chunk()` —— 按 CJK 字符占比分流
- 第 69 行 `_chunk_cjk()` —— 按标点切句 → 按**字符数**打包
- 第 56 行 `_chunk_words()` —— 英文按**词**（原逻辑）

**为什么中文不能按词分块？** 中文没有空格，`text.split()` 会把整篇当成几个"词"。一份 4000 字的中文简历会坍缩成 **1 个块**，块内 embedding 被全文平均稀释，具体问题的相似度直接掉到阈值以下。

**② `retrieve()`（第 150–210 行）—— 检索 SQL**

盯住 `WHERE` 子句：

```sql
AND dc.organization_id = :org_id      -- 多租户隔离，前置过滤
AND d.is_active = TRUE                -- 软删除的文档不参与检索
AND 1 - (embedding <=> ...) >= :threshold
```

**隔离是在 SQL 里做的，不是查完再筛** —— 这是安全设计，不是性能优化。

> ### ✅ 自测
> 1. 把 `CJK_RATIO_THRESHOLD` 从 0.1 改成 1.0 会发生什么？为什么？
> 2. `RAG_SIMILARITY_THRESHOLD` 设太高会怎样？（提示：正确文档可能排第 1 却仍被丢弃）
> 3. `_text_fallback()` 什么时候会被调用？它的召回质量如何？
> 4. `build_augmented_prompt()` 在没有检索结果时，系统提示词有什么不同？

---

## 6. 阶段五：流式 —— 最难也最有含金量

**读 `app/api/v1/chat.py`**：`chat_stream()`（第 206 行起）+ 开头三个辅助函数。

先看 **`_sse()`（第 60 行）** 和事件时序，再逐个啃辅助函数：

| 函数 | 行号 | 解决什么问题 |
|---|---|---|
| `_stream_with_heartbeat()` | 65 | 心跳保活。用 **producer 任务 + `asyncio.Queue`** |
| `_persist_assistant_message()` | 98 | 断连时落库，用**新的 DB session** |
| `generate()` 的 `finally` | 291 | `asyncio.shield` 保护写入 |

### 三个必须想明白的点

**① 为什么心跳不能用 `asyncio.wait_for` 直接包住 LLM 流？**
超时会**取消底层流**，把 httpx 的连接搞坏。所以用队列：超时只取消 `queue.get()`。

**② 为什么 `finally` 里的 `await` 会被跳过？**
客户端断开 → 任务被取消 → `finally` 里的 `await` **会被立即再次取消** → 写库代码根本没执行。用 `asyncio.shield` 包住才能让写入在后台完成。

**③ 为什么保存助手消息要用新的 DB session？**
请求作用域的 session 在断连时可能已经拆掉了，不能在清理逻辑里依赖它。

> 这三个坑的共同点：**都不是"写错了"，而是异步取消语义的陷阱**。对着 `architecture.md` §4.1 读。

> ### ✅ 自测
> 1. 客户端在流中间断开，数据库里会有什么？（用户消息？助手消息？半截的？）
> 2. 为什么用户消息要在开始流之前就 `commit()`？
> 3. `status` 事件有什么作用？把它删掉用户会感觉到什么差异？
> 4. `SSE_HEARTBEAT_SECONDS` 调成 1 会怎样？调成 300 呢？

---

## 7. 阶段六：进阶

| 主题 | 文件 | 关键问题 |
|---|---|---|
| 图谱检索 | `rag/lightrag_retriever.py` | 为什么只取图谱层、生成仍用自己的 `llm_service`？ |
| 统一入库 | `rag/ingest.py` | 双写为什么走 `BackgroundTasks`？为什么图谱失败不阻断主流程？ |
| 文档解析 | `rag/parsers.py` | 为什么 PDF 要 PyMuPDF 主 + pypdf 兜底？ |
| 图谱接口 | `api/v1/graph.py` | 为什么按 `organization_id` 当 workspace？ |

---

## 8. 动手实验（验证你真懂了）

按难度递增，**每个都能立刻看到效果**：

**① 阈值实验** —— 理解检索过滤
把 `.env` 的 `RAG_SIMILARITY_THRESHOLD` 从 `0.5` 调到 `0.9`，重启，问"试用期多久"。观察检索命中变空、模型回答"我不知道"。**调回 0.5。**

**② 分块实验** —— 理解中文分块
把 `retriever.py` 的 `CJK_RATIO_THRESHOLD` 改成 `1.0`（强制走按词路径），重新导入一份中文文档，看日志里 chunk 数从 9 变 1。

**③ 链路切换实验** —— 理解三种模式
把 `.env` 的 `RAG_BACKEND` 在 `hybrid` / `legacy` / `lightrag` 之间切换，问同一个问题，对比召回。**注意切换不迁移数据**：切到 `lightrag` 前要先跑 `scripts/reindex_lightrag.py` 回灌，否则图谱里没有文档。

**④ 降级实验** —— 理解可用性优先
临时把 `LLM_API_KEY` 置空，重启，发一条消息。观察 demo 模式返回的提示文案。

**⑤ 断连实验** —— 理解 shield
```bash
curl -sN -X POST .../chat/stream -H "Authorization: Bearer $TOK" \
  -d '{"message":"请详细介绍重庆邮电大学","use_rag":false}' | head -c 200
```
管道 `head` 会在读满后关闭连接。然后查数据库 —— **半截回答应该已经落库了**。

---

## 9. 调试技巧

**看日志（最好用）**
```bash
docker compose logs -f backend          # 实时跟随
docker compose logs backend --tail 50   # 看最近 50 行
```
注意 `DEBUG=true` 会让 SQLAlchemy echo 每条 SQL —— 排查数据库问题很有用，但也非常吵。

**在容器里直接跑代码**（不用改代码就能验证假设）
```bash
docker compose exec backend python -c "
import asyncio
from app.core.config import settings
print('RAG_BACKEND =', settings.RAG_BACKEND)
"
```

**用 Swagger 打接口**
http://localhost:8000/api/docs —— 点 `Authorize` 填入登录返回的 `access_token`，之后所有接口都能直接试。

**看一次请求的完整 SQL**
```bash
docker compose logs backend --tail 100 | grep -A5 "SELECT"
```

---

## 10. 常见困惑（为什么是这样设计的）

**Q: 为什么要搞 `base.py` 协议 + `factory.py`，直接 import 不行吗？**
A: 因为要**多链路可切换**。三种模式返回同一个 `RAGContext`，上层（提示词、SSE、前端）完全无感知。这也是能做 A/B 对比的前提。

**Q: 默认的 `hybrid` 为什么按排名融合，而不是把两个分数加权平均？**
A: 因为两条链路的分数**不可比** —— 向量链路是余弦相似度，图谱链路是排名代理值（LightRAG 不返回相似度）。加权平均没有意义。RRF 只用排名，天然规避量纲问题。

**Q: 为什么 `parsers.py` 里 PDF 要用两个库？**
A: PyMuPDF 能通过字形名反查恢复**缺失 `/ToUnicode` CMap** 的中文 PDF（LaTeX 生成的很常见），pypdf 对这类文件只会输出乱码。但 pypdf 是更保守的兜底。

**Q: 为什么 `metadata_` 带下划线？**
A: `metadata` 是 SQLAlchemy `Base` 的保留属性名，冲突了。

**Q: 为什么阈值默认是 0.5 而不是 0.7？**
A: 阈值要**按 embedding 模型调**。OpenAI 的 `text-embedding-3-*` 分数偏高（~0.7），bge-m3 偏低（~0.5）。设太高会让**排在第 1 的正确文档也被丢弃** —— 这是最隐蔽的一类 RAG 故障。

**Q: `RATE_LIMIT_PER_MINUTE` 改了怎么不生效？**
A: 因为限额是**硬编码在装饰器里**的（`@limiter.limit("30/minute")`），且 slowapi 用的是**内存存储**、按进程计数（`uvicorn --workers 2`）。详见 `architecture.md` §10。

---

## 11. 前端（待补）

前端部分尚未撰写。简要参考：

- `services/stream.ts` —— 为什么不能用 `EventSource`（只能 GET / 不能带 Authorization / 无法取消），改用 `fetch` + `ReadableStream` 手写 SSE 解析
- `pages/GraphPage.tsx` —— Sigma.js 力导向布局，同步 ForceAtlas2 跑到收敛
- `components/Sidebar.tsx` —— 模态框为什么必须用 `createPortal`（侧栏的 `backdrop-blur` 会成为 `position: fixed` 的包含块）

---

## 附：一条命令的路标

```
main.py → config.py → models/ → auth.py → chat.py(chat 非流式, 122-201)
   → rag/{base,embeddings,llm_service,prompt,retriever}
   → chat.py(chat_stream + 三个辅助函数, 60-118 / 206+)
   → lightrag_retriever / ingest / parsers
```
