import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from '@react-sigma/core'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import Graph from 'graphology'
import '@react-sigma/core/lib/style.css'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, RefreshCw, Share2 } from 'lucide-react'
import clsx from 'clsx'
import { chatApi } from '@/services/api'

interface GraphNode {
  id: string
  labels?: string[]
  properties?: { entity_type?: string; description?: string; [k: string]: unknown }
  size?: number
}

interface GraphEdge {
  id?: string
  source: string
  target: string
  properties?: { description?: string; keywords?: string; weight?: number }
  type?: string
}

interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  is_truncated?: boolean
}

// Palette mirrors LightRAG's graphColor.ts so the two UIs read the same way.
const TYPE_COLORS: Record<string, string> = {
  person: '#4169E1',
  organization: '#00cc00',
  location: '#cf6d17',
  event: '#00bfa0',
  concept: '#e3493b',
  method: '#b71c1c',
  content: '#0f558a',
  data: '#2e7d32',
  artifact: '#8e24aa',
  creature: '#bd7ebe',
  naturalobject: '#6d4c41',
  unknown: '#5D6D7E',
}
const DEFAULT_NODE_COLOR = '#5D6D7E'

function normalizeType(raw?: string): string {
  const t = (raw || 'unknown').toLowerCase().replace(/[\s_-]/g, '')
  return t in TYPE_COLORS ? t : 'unknown'
}

function colorForType(raw?: string): string {
  return TYPE_COLORS[normalizeType(raw)] || DEFAULT_NODE_COLOR
}

export default function GraphPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [maxDepth, setMaxDepth] = useState(3)
  const [maxNodes, setMaxNodes] = useState(300)
  const [hovered, setHovered] = useState<{ node: GraphNode; x: number; y: number } | null>(null)

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

  const legendTypes = useMemo(() => {
    const seen = new Set<string>()
    for (const n of data?.nodes || []) seen.add(normalizeType(n.properties?.entity_type))
    return Array.from(seen).sort()
  }, [data])

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
            <h1 className="text-sm font-semibold text-white">Knowledge Graph</h1>
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
              Set <code className="text-brand-400">RAG_BACKEND=lightrag</code> and import documents
              to populate it.
            </p>
          </div>
        )}

        {data && data.nodes.length > 0 && (
          <>
            <SigmaContainer
              className="!bg-transparent"
              settings={{
                allowInvalidContainer: true,
                renderEdgeLabels: false,
                hideEdgesOnMove: true,
                labelGridCellSize: 60,
                labelRenderedSizeThreshold: 8,
                defaultEdgeColor: 'rgba(148,163,184,0.25)',
                labelColor: { color: '#cbd5e1' },
              }}
            >
              <GraphLoader data={data} />
              <FitOnLoad signature={`${data.nodes.length}-${data.edges.length}`} />
              <NodeHover onHover={setHovered} />
            </SigmaContainer>

            <div className="absolute bottom-4 left-4 glass-card px-4 py-3 z-10 pointer-events-none">
              <p className="text-xs text-gray-400 mb-2 font-medium">Entity types</p>
              <div className="space-y-1.5">
                {legendTypes.map(t => (
                  <div key={t} className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: colorForType(t) }} />
                    <span className="text-xs text-gray-300">{t}</span>
                  </div>
                ))}
              </div>
            </div>

            {hovered && (
              <div
                className="absolute glass-card px-3 py-2 z-20 pointer-events-none max-w-sm"
                style={{ left: hovered.x + 14, top: hovered.y + 14 }}
              >
                <p className="text-xs font-medium text-white">{hovered.node.id}</p>
                <p className="text-[10px] uppercase tracking-wide mb-1"
                   style={{ color: colorForType(hovered.node.properties?.entity_type) }}>
                  {normalizeType(hovered.node.properties?.entity_type)}
                </p>
                {hovered.node.properties?.description && (
                  <p className="text-xs text-gray-400 leading-snug line-clamp-4">
                    {String(hovered.node.properties.description)}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- graph parts

function GraphLoader({ data }: { data: GraphData }) {
  const loadGraph = useLoadGraph()

  useEffect(() => {
    const graph = new Graph({ multi: true, type: 'directed' })
    const degree: Record<string, number> = {}

    // Seed positions on a circle rather than in a unit box: ForceAtlas2 needs
    // spread to work with, and a tight random start just gives overlapping
    // clumps it never pulls apart.
    const radius = 20 + data.nodes.length * 1.5
    data.nodes.forEach((n, i) => {
      const angle = (i / Math.max(data.nodes.length, 1)) * Math.PI * 2
      degree[n.id] = 0
      graph.addNode(n.id, {
        label: n.id,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        size: 6,
        entityType: normalizeType(n.properties?.entity_type),
        description: n.properties?.description || '',
        color: colorForType(n.properties?.entity_type),
      })
    })

    for (const e of data.edges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue
      degree[e.source] = (degree[e.source] || 0) + 1
      degree[e.target] = (degree[e.target] || 0) + 1
      // Self-loops and parallel edges are valid in the data but add no signal.
      if (e.source === e.target || graph.hasEdge(e.source, e.target)) continue
      graph.addEdge(e.source, e.target, {
        size: Math.max(0.4, Math.min(2, Number(e.properties?.weight) || 1)),
        color: 'rgba(148,163,184,0.25)',
      })
    }

    // Size by connectivity, so hubs read as hubs.
    graph.forEachNode(node => {
      graph.setNodeAttribute(node, 'size', 5 + Math.sqrt(degree[node] || 0) * 4)
    })

    // Layout synchronously rather than with the worker: this graph is small
    // enough that a fixed number of iterations runs in well under a second and
    // converges deterministically, so the camera fit below is always taken
    // against a settled layout.
    if (graph.order > 1) {
      forceAtlas2.assign(graph, {
        iterations: 300,
        settings: {
          gravity: 3,
          scalingRatio: 30,
          adjustSizes: true,
          barnesHutOptimize: true,
        },
      })
    }

    loadGraph(graph)
  }, [data, loadGraph])

  return null
}

/** Frame the whole graph once it has been loaded and laid out. */
function FitOnLoad({ signature }: { signature: string }) {
  const sigma = useSigma()
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        sigma.getCamera().animatedReset({ duration: 400 })
      } catch {
        // Sigma may not be attached yet on a very fast remount; harmless.
      }
    }, 80)
    return () => clearTimeout(t)
  }, [signature, sigma])

  return null
}

function NodeHover({ onHover }: { onHover: (v: { node: GraphNode; x: number; y: number } | null) => void }) {
  const registerEvents = useRegisterEvents()
  const sigma = useSigma()

  useEffect(() => {
    registerEvents({
      enterNode: ({ node }) => {
        const attrs = sigma.getGraph().getNodeAttributes(node)
        const pos = sigma.graphToViewport({ x: attrs.x as number, y: attrs.y as number })
        onHover({
          node: {
            id: node,
            properties: {
              entity_type: attrs.entityType as string,
              description: attrs.description as string,
            },
          },
          x: pos.x,
          y: pos.y,
        })
      },
      leaveNode: () => onHover(null),
    })
  }, [registerEvents, sigma, onHover])

  return null
}
