import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, RefreshCw, Share2 } from 'lucide-react'
import clsx from 'clsx'
import KnowledgeGraph, { type GraphData } from '@/components/KnowledgeGraph'
import { chatApi } from '@/services/api'

/**
 * Standalone full-screen graph view. The Knowledge Base page embeds the same
 * component under its 知识图谱 tab.
 */
export default function GraphPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [maxDepth, setMaxDepth] = useState(3)
  const [maxNodes, setMaxNodes] = useState(300)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const { data } = await chatApi.getGraph({ label: '*', max_depth: maxDepth, max_nodes: maxNodes })
      setData(data)
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(detail || 'Failed to load the knowledge graph.')
      setData(null)
    }
    setLoading(false)
  }, [maxDepth, maxNodes])

  useEffect(() => { void load() }, [load])

  const isEmpty = !loading && !error && (data?.nodes?.length ?? 0) === 0

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="glass border-b border-white/5 px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/chat')} className="btn-ghost p-1.5" title="Back to chat">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="w-8 h-8 bg-brand-600/30 rounded-lg flex items-center justify-center">
            <Share2 className="w-4 h-4 text-brand-400" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-strong">Knowledge Graph</h1>
            <p className="text-xs text-gray-500">
              {data ? `${data.nodes.length} entities · ${data.edges.length} relations` : 'Loading…'}
              {data?.is_truncated ? ' · truncated' : ''}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">Depth</label>
          <select
            value={maxDepth}
            onChange={e => setMaxDepth(Number(e.target.value))}
            className="bg-surface-100 border border-white/8 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none"
          >
            {[1, 2, 3, 4, 5].map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <label className="text-xs text-gray-500 ml-1">Max nodes</label>
          <select
            value={maxNodes}
            onChange={e => setMaxNodes(Number(e.target.value))}
            className="bg-surface-100 border border-white/8 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none"
          >
            {[100, 300, 600, 1000].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <button onClick={() => void load()} className="btn-ghost p-2" title="Reload">
            <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
          </button>
        </div>
      </header>

      <div className="flex-1 relative min-h-0">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 gap-2 z-10">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading knowledge graph…
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10">
            <p className="text-red-400 text-sm">{error}</p>
            <button onClick={() => void load()} className="btn-primary">Retry</button>
          </div>
        )}

        {isEmpty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 text-center px-6">
            <Share2 className="w-8 h-8 text-gray-700" />
            <p className="text-gray-400 text-sm">No knowledge graph yet</p>
            <p className="text-gray-600 text-xs max-w-md">
              The graph is built by LightRAG entity extraction during ingestion.
              Import documents to populate it.
            </p>
          </div>
        )}

        {data && data.nodes.length > 0 && <KnowledgeGraph data={data} />}
      </div>
    </div>
  )
}
