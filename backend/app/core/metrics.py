"""
轻量运行时指标 —— 进程内累积，由 /metrics 端点读出。

设计取舍：不引入 prometheus_client，因为这套系统是单机部署，用 JSON 直接
curl 就能看明白，比接一整套监控栈更实际。将来若要上 Prometheus，把
``snapshot()`` 的输出转成文本格式即可（约 20 行），指标语义不用动。

关注两类故障：
  · 大批量入库 → graph_queue 持续堆积、asyncio_tasks 上涨、rss 上涨
  · 高并发问答 → sse.active 上涨、db_pool.checkedout 触顶、rss 上涨
"""
import asyncio
import resource
import time
from collections import Counter
from typing import Any, Dict

_STARTED_AT = time.time()

# 请求计数（由 AuditLogMiddleware 填充）
_requests_total = 0
_by_status: Counter = Counter()
_by_path: Counter = Counter()
_duration_ms_total = 0.0
_duration_ms_max = 0.0

# SSE 活跃流（由 chat_stream 增减）
_sse_active = 0
_sse_total = 0
_sse_aborted = 0


def record_request(path: str, status_code: int, duration_ms: float) -> None:
    global _requests_total, _duration_ms_total, _duration_ms_max
    _requests_total += 1
    _by_status[str(status_code)] += 1
    # 路径去掉具体 id，避免基数爆炸（/sessions/<uuid> → /sessions/*）
    _by_path[_normalise_path(path)] += 1
    _duration_ms_total += duration_ms
    _duration_ms_max = max(_duration_ms_max, duration_ms)


def _normalise_path(path: str) -> str:
    parts = []
    for seg in path.split("/"):
        # UUID / 长十六进制段视为标识符
        if len(seg) >= 20 and "-" in seg:
            parts.append("{id}")
        else:
            parts.append(seg)
    return "/".join(parts)


def sse_opened() -> None:
    global _sse_active, _sse_total
    _sse_active += 1
    _sse_total += 1


def sse_closed(aborted: bool = False) -> None:
    global _sse_active, _sse_aborted
    _sse_active = max(0, _sse_active - 1)
    if aborted:
        _sse_aborted += 1


def _rss_mb() -> float:
    # ru_maxrss 在 Linux 上是 KB
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)


def _asyncio_tasks() -> int:
    try:
        return len(asyncio.all_tasks())
    except RuntimeError:
        return 0


def _db_pool() -> Dict[str, Any]:
    """连接池占用。checkedout 触顶意味着并发请求在排队等连接。

    ``overflow()`` 是【当前】溢出数（可为负），不是允许的上限 —— 上限取自配置，
    否则会算出 `max = 1` 这种荒谬值。
    """
    from app.core.config import settings
    from app.db.session import engine

    pool = engine.pool
    info: Dict[str, Any] = {}
    for name in ("size", "checkedin", "checkedout"):
        fn = getattr(pool, name, None)
        if callable(fn):
            try:
                info[name] = fn()
            except Exception:  # noqa: BLE001 - 指标不该影响主流程
                pass

    limit = settings.DATABASE_POOL_SIZE + settings.DATABASE_MAX_OVERFLOW
    info["overflow_current"] = info.get("checkedout", 0) - info.get("size", 0)
    info["limit"] = limit
    info["utilisation"] = round(info.get("checkedout", 0) / limit, 3) if limit else 0.0
    return info


def _graph_queue() -> Dict[str, Any]:
    from app.rag.ingest import pending_graph_tasks

    tasks = pending_graph_tasks()
    return {
        "pending": len(tasks),
        "indexing": sum(1 for t in tasks if t["kind"] == "index"),
        "deleting": sum(1 for t in tasks if t["kind"] == "delete"),
    }


def _lightrag_engines() -> int:
    from app.rag.lightrag_retriever import _ENGINES

    return len(_ENGINES)


def snapshot() -> Dict[str, Any]:
    """当前所有指标的瞬时值。"""
    avg = round(_duration_ms_total / _requests_total, 2) if _requests_total else 0.0
    return {
        "uptime_seconds": round(time.time() - _STARTED_AT, 1),
        "process": {
            "rss_mb": _rss_mb(),
            "asyncio_tasks": _asyncio_tasks(),
            "lightrag_workspaces": _lightrag_engines(),
        },
        "db_pool": _db_pool(),
        "graph_queue": _graph_queue(),
        "sse": {
            "active": _sse_active,
            "opened_total": _sse_total,
            "aborted_total": _sse_aborted,
        },
        "requests": {
            "total": _requests_total,
            "by_status": dict(_by_status),
            "by_path": dict(_by_path.most_common(20)),
            "duration_ms_avg": avg,
            "duration_ms_max": round(_duration_ms_max, 2),
        },
    }
