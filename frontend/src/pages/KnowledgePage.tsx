import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Database, FileText, Loader2, RefreshCw, RotateCcw, Share2, Trash2,
} from 'lucide-react'
import clsx from 'clsx'
import Sidebar from '@/components/Sidebar'
import DocumentUploader from '@/components/DocumentUploader'
import KnowledgeGraph, { type GraphData } from '@/components/KnowledgeGraph'
import { chatApi } from '@/services/api'
import type { Document } from '@/types'

/**
 * Processing stages, mirroring LightRAG's DocStatus enum:
 * PENDING → PARSING → ANALYZING → PROCESSING → PROCESSED | FAILED.
 */
const STATUS_TABS: { id: string; label: string; statuses: string[] }[] = [
  { id: 'all', label: '全部', statuses: [] },
  { id: 'processed', label: '已完成', statuses: ['processed'] },
  { id: 'parsing', label: '文件解析', statuses: ['parsing', 'pending'] },
  { id: 'analyzing', label: '模态分析', statuses: ['analyzing'] },
  { id: 'processing', label: '图谱处理', statuses: ['processing'] },
  { id: 'failed', label: '失败', statuses: ['failed'] },
]

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  processed: { label: '已完成', className: 'bg-green-500/15 text-green-400' },
  pending: { label: '排队中', className: 'bg-slate-500/15 text-slate-400' },
  parsing: { label: '文件解析', className: 'bg-blue-500/15 text-blue-400' },
  analyzing: { label: '模态分析', className: 'bg-purple-500/15 text-purple-400' },
  processing: { label: '图谱处理', className: 'bg-amber-500/15 text-amber-400' },
  failed: { label: '失败', className: 'bg-red-500/15 text-red-400' },
}

function statusBadge(status?: string | null) {
  if (!status) return { label: '未入库图谱', className: 'bg-slate-500/15 text-slate-500' }
  return STATUS_BADGE[status] || { label: status, className: 'bg-slate-500/15 text-slate-400' }
}

export default function KnowledgePage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'documents' | 'graph'>('documents')

  const [docs, setDocs] = useState<Document[]>([])
  const [loadingDocs, setLoadingDocs] = useState(true)
  const [statusTab, setStatusTab] = useState('all')
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  // Row awaiting delete confirmation — a bare icon click must not silently drop
  // a document out of retrieval.
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const [graph, setGraph] = useState<GraphData | null>(null)
  const [loadingGraph, setLoadingGraph] = useState(false)
  const [graphError, setGraphError] = useState('')
  // Graph indexing/deletion runs in the background, so the graph can lag the
  // document list. Surfaced rather than hidden — a stale graph that looks
  // current is worse than one labelled as catching up.
  const [pending, setPending] = useState({ indexing: 0, deleting: 0, count: 0 })

  const loadDocs = useCallback(async () => {
    setLoadingDocs(true)
    try {
      const { data } = await chatApi.getDocuments(true)
      setDocs(data)
    } catch {
      setDocs([])
    }
    setLoadingDocs(false)
  }, [])

  const loadGraph = useCallback(async () => {
    setLoadingGraph(true); setGraphError('')
    try {
      const { data } = await chatApi.getGraph({ label: '*', max_depth: 3, max_nodes: 600 })
      setGraph(data)
    } catch {
      setGraphError('加载知识图谱失败')
      setGraph(null)
    }
    setLoadingGraph(false)
  }, [])

  useEffect(() => { void loadDocs() }, [loadDocs])
  // The graph is only fetched when its tab is opened — it is the heavier call.
  useEffect(() => { if (tab === 'graph' && !graph) void loadGraph() }, [tab, graph, loadGraph])

  // Poll the graph-work queue while its tab is open; when work is in flight,
  // refresh the graph itself so the view converges without a manual reload.
  useEffect(() => {
    if (tab !== 'graph') return
    let stopped = false
    let wasBusy = false

    const tick = async () => {
      try {
        const { data } = await chatApi.getGraphStatus()
        if (stopped) return
        const busy = data.pending_count > 0
        setPending({ indexing: data.indexing, deleting: data.deleting, count: data.pending_count })
        // Work just finished → pull the settled graph once.
        if (wasBusy && !busy) void loadGraph()
        wasBusy = busy
      } catch {
        // Status is advisory; a failure just means no banner.
      }
    }

    void tick()
    const id = setInterval(tick, 3000)
    return () => { stopped = true; clearInterval(id) }
  }, [tab, loadGraph])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: docs.length }
    for (const t of STATUS_TABS) {
      if (t.id === 'all') continue
      c[t.id] = docs.filter(d => t.statuses.includes(d.processing_status || '')).length
    }
    return c
  }, [docs])

  const visible = useMemo(() => {
    const tabDef = STATUS_TABS.find(t => t.id === statusTab)
    return docs.filter(d => {
      if (tabDef && tabDef.statuses.length && !tabDef.statuses.includes(d.processing_status || '')) return false
      if (query && !`${d.title} ${d.source || ''}`.toLowerCase().includes(query.toLowerCase())) return false
      return true
    })
  }, [docs, statusTab, query])

  const remove = async (id: string) => {
    setConfirmingId(null)
    setBusyId(id)
    await chatApi.deleteDocument(id)
    await loadDocs()
    setBusyId(null)
  }

  const restore = async (id: string) => {
    setBusyId(id)
    await chatApi.restoreDocument(id)
    await loadDocs()
    setBusyId(null)
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />

      <main className="flex-1 flex flex-col min-w-0">
        <header className="glass border-b border-white/5 px-6 py-3 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/chat')} className="btn-ghost p-1.5" title="返回对话">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="w-8 h-8 bg-brand-600/30 rounded-lg flex items-center justify-center">
              <Database className="w-4 h-4 text-brand-400" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-strong">Knowledge Base</h1>
              <p className="text-xs text-gray-500">
                {docs.length} 个文档 · {docs.filter(d => d.is_active).length} 参与检索
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 p-1 rounded-xl bg-surface-100 border border-white/5">
            <button
              onClick={() => setTab('documents')}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors',
                tab === 'documents' ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200',
              )}
            >
              <FileText className="w-3.5 h-3.5" /> 文档
            </button>
            <button
              onClick={() => setTab('graph')}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors',
                tab === 'graph' ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200',
              )}
            >
              <Share2 className="w-3.5 h-3.5" /> 知识图谱
            </button>
          </div>
        </header>

        {tab === 'documents' ? (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-5xl mx-auto space-y-5">
              <DocumentUploader onUploaded={loadDocs} />

              <div className="flex items-center gap-2 flex-wrap">
                {STATUS_TABS.map(t => (
                  <button
                    key={t.id}
                    onClick={() => setStatusTab(t.id)}
                    className={clsx(
                      'px-3 py-1.5 rounded-lg text-xs transition-colors border',
                      statusTab === t.id
                        ? 'bg-brand-600/20 text-brand-300 border-brand-500/30'
                        : 'text-gray-400 border-white/5 hover:text-gray-200 hover:bg-white/5',
                    )}
                  >
                    {t.label}
                    <span className="ml-1.5 text-gray-500">{counts[t.id] ?? 0}</span>
                  </button>
                ))}

                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="搜索文档…"
                  className="input-field !w-48 ml-auto text-xs py-1.5"
                />
                <button onClick={() => void loadDocs()} className="btn-ghost p-2" title="刷新">
                  <RefreshCw className={clsx('w-4 h-4', loadingDocs && 'animate-spin')} />
                </button>
              </div>

              <div className="glass-card overflow-hidden">
                {loadingDocs ? (
                  <div className="flex items-center justify-center gap-2 py-12 text-gray-500 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
                  </div>
                ) : visible.length === 0 ? (
                  <div className="py-12 text-center text-sm text-gray-500">没有符合条件的文档</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b border-white/5">
                        <th className="text-left font-medium px-4 py-2.5">文档</th>
                        <th className="text-left font-medium px-4 py-2.5 w-32">类型</th>
                        <th className="text-left font-medium px-4 py-2.5 w-32">状态</th>
                        <th className="text-right font-medium px-4 py-2.5 w-28">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map(d => {
                        const badge = statusBadge(d.processing_status)
                        return (
                          <tr
                            key={d.id}
                            className={clsx(
                              'border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors',
                              !d.is_active && 'opacity-60',
                            )}
                          >
                            <td className="px-4 py-3">
                              <p className={clsx('truncate max-w-md', d.is_active ? 'text-gray-200' : 'text-gray-500 line-through')}>
                                {d.title}
                              </p>
                              <p className="text-xs text-gray-600 truncate max-w-md">{d.source || '—'}</p>
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-500">{d.doc_type}</td>
                            <td className="px-4 py-3">
                              <span className={clsx('px-2 py-0.5 rounded text-[11px]', badge.className)}>
                                {badge.label}
                              </span>
                              {!d.is_active && (
                                <span className="ml-1 px-2 py-0.5 rounded text-[11px] bg-amber-500/15 text-amber-400">
                                  已停用
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {busyId === d.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin inline text-gray-500" />
                              ) : d.is_active ? (
                                confirmingId === d.id ? (
                                  <div className="flex items-center gap-1 justify-end">
                                    <button
                                      onClick={() => void remove(d.id)}
                                      className="text-[11px] px-2 py-1 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                                    >
                                      确认删除
                                    </button>
                                    <button
                                      onClick={() => setConfirmingId(null)}
                                      className="text-[11px] px-2 py-1 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-colors"
                                    >
                                      取消
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => setConfirmingId(d.id)}
                                    title="从检索中移除"
                                    className="text-gray-600 hover:text-red-400 transition-colors p-1"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )
                              ) : (
                                <button
                                  onClick={() => void restore(d.id)}
                                  title="恢复并重新加入检索"
                                  className="text-gray-600 hover:text-green-400 transition-colors p-1"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              <p className="text-xs text-gray-600">
                删除是软删除 —— 文档会保留在列表里并标记「已停用」，检索时被排除。点恢复即可重新加入。
                图谱侧的清理在后台进行，可能有几秒延迟。
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-1 relative min-h-0">
            {loadingGraph && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-gray-500 text-sm z-10">
                <Loader2 className="w-4 h-4 animate-spin" /> 加载知识图谱…
              </div>
            )}
            {graphError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10">
                <p className="text-red-400 text-sm">{graphError}</p>
                <button onClick={() => void loadGraph()} className="btn-primary">重试</button>
              </div>
            )}
            {!loadingGraph && !graphError && (graph?.nodes?.length ?? 0) === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6 z-10">
                <Share2 className="w-8 h-8 text-gray-700" />
                <p className="text-gray-400 text-sm">知识图谱为空</p>
                <p className="text-gray-600 text-xs max-w-md">
                  图谱由 LightRAG 在入库时做实体抽取生成。上传文档后稍等片刻即可看到。
                </p>
              </div>
            )}
            {graph && graph.nodes.length > 0 && (
              <KnowledgeGraph data={graph} />
            )}

            {/* 图谱任务进行中：索引/删除都走 LLM，图谱会滞后于文档列表 */}
            {pending.count > 0 && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 glass-card px-4 py-2 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-400 flex-shrink-0" />
                <span className="text-xs text-gray-300">
                  {pending.count} 个图谱任务处理中
                  {pending.indexing > 0 && ` · 抽取实体 ${pending.indexing}`}
                  {pending.deleting > 0 && ` · 清理已删 ${pending.deleting}`}
                </span>
                <span className="text-[11px] text-gray-500">图谱可能尚未反映最新变更</span>
              </div>
            )}

            <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
              <span className="text-xs text-gray-500">
                {graph ? `${graph.nodes.length} 实体 · ${graph.edges.length} 关系` : ''}
              </span>
              <button onClick={() => void loadGraph()} className="btn-ghost p-2" title="刷新">
                <RefreshCw className={clsx('w-4 h-4', loadingGraph && 'animate-spin')} />
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
