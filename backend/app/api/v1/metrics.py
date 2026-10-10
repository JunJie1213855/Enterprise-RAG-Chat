"""
运行时指标端点。

排查两条已知的过载路径时最先要看这里：

  大批量入库 → graph_queue.pending 持续上涨 + process.rss_mb 上涨
                （后台任务各持一份文档全文在内存里等 LightRAG 的信号量）
  高并发问答 → sse.active 上涨 + db_pool.checkedout 触顶 + rss 上涨

需要认证：指标会暴露内部结构，不适合无鉴权公开。Prometheus 抓取时把
token 配成 bearer_token 即可（见 README 故障排查章节）。
"""
from typing import Any, Dict

from fastapi import APIRouter, Depends

from app.core import metrics
from app.core.dependencies import get_current_user
from app.models.user import User

router = APIRouter()


@router.get("/metrics")
async def get_metrics(current_user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """当前进程的运行时指标快照（JSON）。"""
    return metrics.snapshot()
