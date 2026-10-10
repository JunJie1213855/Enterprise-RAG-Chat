"""
Knowledge-graph API — read-only view of the LightRAG graph for one organization.

The graph is stored per LightRAG ``workspace``, which we key by
``organization_id``, so the caller's org scopes every query automatically.
"""
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Query
from loguru import logger

from app.core.dependencies import get_current_user
from app.models.user import User

router = APIRouter()

# Guards so a mistyped query cannot ask LightRAG to walk an enormous subgraph.
MAX_DEPTH_LIMIT = 5
MAX_NODES_LIMIT = 2000

# 知识图谱可视化
@router.get("/graph")
async def get_graph(
    label: str = Query("*", description="Entity label to centre the subgraph on; '*' for everything"),
    max_depth: int = Query(3, ge=1, le=MAX_DEPTH_LIMIT, description="Traversal depth from the label"),
    max_nodes: int = Query(300, ge=1, le=MAX_NODES_LIMIT, description="Maximum nodes to return"),
    current_user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Return the organization's knowledge graph as nodes + edges."""
    if not current_user.organization_id:
        raise HTTPException(status_code=400, detail="User has no organization")

    # Imported lazily: LightRAG is heavy and should not load unless the graph
    # endpoint is actually used.
    from app.rag.lightrag_retriever import get_engine

    try:
        rag = await get_engine(current_user.organization_id)
        kg = await rag.get_knowledge_graph(
            node_label=label or "*",
            max_depth=max_depth,
            max_nodes=max_nodes,
        )
    except Exception as e:  # noqa: BLE001
        logger.error(f"Knowledge graph query failed for org {current_user.organization_id}: {e}")
        raise HTTPException(status_code=503, detail="Knowledge graph is unavailable")

    # KnowledgeGraph is a pydantic model; model_dump keeps the response shaped
    # exactly like LightRAG's own /graphs endpoint.
    payload = kg.model_dump() if hasattr(kg, "model_dump") else dict(kg)
    logger.info(
        f"Knowledge graph [{current_user.organization_id}] label='{label}' "
        f"depth={max_depth} -> {len(payload.get('nodes') or [])} nodes, "
        f"{len(payload.get('edges') or [])} edges"
    )
    return payload


@router.get("/graph/status")
async def graph_status(current_user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Progress of in-flight graph work.

    Indexing and deleting both cost LLM calls and run in the background, so the
    graph trails the document list by seconds to minutes. The UI polls this so
    it can say "still catching up" instead of silently showing stale entities.
    """
    from app.rag.ingest import pending_graph_tasks

    tasks = pending_graph_tasks()
    return {
        "pending_count": len(tasks),
        "indexing": sum(1 for t in tasks if t["kind"] == "index"),
        "deleting": sum(1 for t in tasks if t["kind"] == "delete"),
        "tasks": tasks,
    }