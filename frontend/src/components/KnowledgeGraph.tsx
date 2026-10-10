import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSetSettings, useSigma } from '@react-sigma/core'
import { NodeBorderProgram } from '@sigma/node-border'
import { EdgeRectangleProgram, EdgeLineProgram, EdgeArrowProgram } from 'sigma/rendering'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import circular from 'graphology-layout/circular'
import random from 'graphology-layout/random'
import circlepack from 'graphology-layout/circlepack'
import Graph from 'graphology'
import '@react-sigma/core/lib/style.css'
import {
  Crosshair, Maximize2, Minimize2, Search, Tag, X, ZoomIn, ZoomOut, Share2,
} from 'lucide-react'
import clsx from 'clsx'
import { useThemeStore } from '@/store/themeStore'

export interface GraphNode {
  id: string
  labels?: string[]
  properties?: { entity_type?: string; description?: string; [k: string]: unknown }
  size?: number
}

export interface GraphEdge {
  id?: string
  source: string
  target: string
  properties?: { description?: string; keywords?: string; weight?: number }
  type?: string
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  is_truncated?: boolean
}

// ---- 与 LightRAG 前端 (graphColor.ts / constants.ts) 完全一致的配色 ----
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
  geography: '#2e7d32',
  unknown: '#5D6D7E',
}
const DEFAULT_NODE_COLOR = '#5D6D7E'
const NODE_BORDER_COLOR = '#EEEEEE'      // LightRAG: nodeBorderColor
const EDGE_COLOR_DARK = '#888888'        // LightRAG: edgeColorDarkTheme
const EDGE_COLOR_LIGHT = '#d3d3d3'
const LABEL_COLOR_DARK = '#FFFFFF'
const LABEL_COLOR_LIGHT = '#000000'
const HIGHLIGHT_COLOR = '#F57F17'        // LightRAG: nodeBorderColorSelected / edgeColorHighlighted

export function normalizeType(raw?: string): string {
  const t = (raw || 'unknown').toLowerCase().replace(/[\s_-]/g, '')
  return t in TYPE_COLORS ? t : 'unknown'
}

export function colorForType(raw?: string): string {
  return TYPE_COLORS[normalizeType(raw)] || DEFAULT_NODE_COLOR
}

type LayoutName = 'force' | 'circular' | 'circlepack' | 'random'

const LAYOUTS: { id: LayoutName; label: string }[] = [
  { id: 'force', label: '力导向' },
  { id: 'circular', label: '环形' },
  { id: 'circlepack', label: '圆堆积' },
  { id: 'random', label: '随机' },
]

type Hovered = { node: GraphNode; x: number; y: number }

/** 实体-关系图谱：外观与控件对齐 LightRAG 自带前端。 */
export default function KnowledgeGraph({ data }: { data: GraphData }) {
  const { theme } = useThemeStore()
  const isDark = theme === 'eye'

  const containerRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<Hovered | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  // 点击实体后进入「聚焦隔离」：只保留它的邻域，其余节点与边隐藏，相机放大过去
  const [focusId, setFocusId] = useState<string | null>(null)
  const [showLabels, setShowLabels] = useState(true)
  const [showLegend, setShowLegend] = useState(true)
  const [layout, setLayout] = useState<LayoutName>('force')
  const [fullscreen, setFullscreen] = useState(false)
  const [query, setQuery] = useState('')

  const legendTypes = useMemo(() => {
    const seen = new Set<string>()
    for (const n of data.nodes || []) seen.add(normalizeType(n.properties?.entity_type))
    return Array.from(seen).sort()
  }, [data])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return data.nodes.filter(n => n.id.toLowerCase().includes(q)).slice(0, 8)
  }, [data, query])

  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return
    if (document.fullscreenElement) {
      await document.exitFullscreen()
      setFullscreen(false)
    } else {
      await containerRef.current.requestFullscreen()
      setFullscreen(true)
    }
  }, [])

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-surface">
      <SigmaContainer
        className="!bg-transparent !size-full"
        settings={{
          allowInvalidContainer: true,
          // LightRAG 的标志性外观：每个节点带一圈浅色描边
          defaultNodeType: 'border',
          nodeProgramClasses: { border: NodeBorderProgram },
          // 设了 defaultEdgeType 就必须注册对应程序，否则 Sigma 直接抛
          // "could not find a suitable program for edge type" 整张图渲染不出来。
          defaultEdgeType: 'rect',
          edgeProgramClasses: {
            rect: EdgeRectangleProgram,
            line: EdgeLineProgram,
            arrow: EdgeArrowProgram,
          },
          renderEdgeLabels: false,
          hideEdgesOnMove: true,
          labelGridCellSize: 60,
          labelRenderedSizeThreshold: showLabels ? 6 : Number.MAX_SAFE_INTEGER,
          defaultEdgeColor: isDark ? EDGE_COLOR_DARK : EDGE_COLOR_LIGHT,
          labelColor: { color: isDark ? LABEL_COLOR_DARK : LABEL_COLOR_LIGHT },
        }}
      >
        <GraphLoader data={data} layout={layout} />
        <FitOnLoad signature={`${data.nodes.length}-${data.edges.length}-${layout}`} />
        <GraphEvents
          onHover={setHovered}
          onHoverId={setHoveredId}
          onSelect={(n) => { setSelected(n); setFocusId(n?.id ?? null) }}
          onClearFocus={() => { setFocusId(null); setSelected(null) }}
        />
        <GraphFocus hoveredId={hoveredId} focusId={focusId} selectedId={selected?.id ?? null} />
        <CameraApi />
      </SigmaContainer>

      {/* ---- 左上：实体搜索 + 标签开关 ---- */}
      <div className="absolute top-3 left-3 z-10 flex items-start gap-2">
        <div className="glass-card flex items-center gap-2 px-3 py-2">
          <Search className="w-3.5 h-3.5 text-gray-500" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索实体…"
            className="bg-transparent text-xs text-gray-200 placeholder-gray-500 outline-none w-44"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-gray-500 hover:text-gray-300">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <button
          onClick={() => setShowLabels(v => !v)}
          title={showLabels ? '隐藏标签' : '显示标签'}
          className={clsx('glass-card p-2 transition-colors', showLabels ? 'text-brand-400' : 'text-gray-500')}
        >
          <Tag className="w-4 h-4" />
        </button>
      </div>

      {matches.length > 0 && (
        <div className="absolute top-16 left-3 z-20 glass-card py-1 w-64 max-h-64 overflow-y-auto">
          {matches.map(n => (
            <button
              key={n.id}
              onClick={() => { setSelected(n); setFocusId(n.id); setQuery('') }}
              className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-white/5 flex items-center gap-2"
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: colorForType(n.properties?.entity_type) }}
              />
              <span className="truncate">{n.id}</span>
            </button>
          ))}
        </div>
      )}

      {/* ---- 左下：与 LightRAG 一致的竖排控制面板 ---- */}
      <div className="absolute bottom-3 left-3 z-10 glass-card flex flex-col rounded-xl py-1">
        <PanelButton title="放大" onClick={() => window.dispatchEvent(new Event('kg:zoomIn'))}>
          <ZoomIn className="w-4 h-4" />
        </PanelButton>
        <PanelButton title="缩小" onClick={() => window.dispatchEvent(new Event('kg:zoomOut'))}>
          <ZoomOut className="w-4 h-4" />
        </PanelButton>
        <PanelButton title="重置视角" onClick={() => window.dispatchEvent(new Event('kg:reset'))}>
          <Crosshair className="w-4 h-4" />
        </PanelButton>
        <PanelButton title={fullscreen ? '退出全屏' : '全屏'} onClick={() => void toggleFullscreen()}>
          {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </PanelButton>
        <PanelButton title="图例" onClick={() => setShowLegend(v => !v)} active={showLegend}>
          <Share2 className="w-4 h-4" />
        </PanelButton>
        <div className="border-t border-white/5 my-1" />
        {LAYOUTS.map(l => (
          <button
            key={l.id}
            onClick={() => setLayout(l.id)}
            title={l.label}
            className={clsx(
              'px-2 py-1.5 text-[10px] transition-colors',
              layout === l.id ? 'text-brand-400' : 'text-gray-500 hover:text-gray-300',
            )}
          >
            {l.label}
          </button>
        ))}
      </div>

      {/* ---- 聚焦隔离提示 ---- */}
      {focusId && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 glass-card px-4 py-2 flex items-center gap-3">
          <span className="text-xs text-gray-400">聚焦中，仅显示相关实体</span>
          <button
            onClick={() => { setFocusId(null); setSelected(null) }}
            className="text-xs text-brand-400 hover:text-brand-300 transition-colors"
          >
            退出（Esc）
          </button>
        </div>
      )}

      {/* ---- 右上：实体属性 ---- */}
      {selected && (
        <div className="absolute top-3 right-3 z-10 glass-card p-4 w-72 max-h-[60%] overflow-y-auto">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium text-strong break-all">{selected.id}</p>
            <button
              onClick={() => { setSelected(null); setFocusId(null) }}
              className="text-gray-500 hover:text-gray-300 flex-shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <p
            className="text-[10px] uppercase tracking-wide mt-1 mb-2"
            style={{ color: colorForType(selected.properties?.entity_type) }}
          >
            {normalizeType(selected.properties?.entity_type)}
          </p>
          {selected.properties?.description && (
            <p className="text-xs text-gray-400 leading-relaxed whitespace-pre-wrap">
              {String(selected.properties.description)}
            </p>
          )}
        </div>
      )}

      {/* ---- 右下：图例 ---- */}
      {showLegend && (
        <div className="absolute bottom-3 right-3 z-10 glass-card px-4 py-3 max-h-[55%] overflow-y-auto">
          <p className="text-xs text-gray-400 mb-2 font-medium">实体类型</p>
          <div className="space-y-1.5">
            {legendTypes.map(t => (
              <div key={t} className="flex items-center gap-2">
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ background: colorForType(t), boxShadow: `0 0 0 1.5px ${NODE_BORDER_COLOR}` }}
                />
                <span className="text-xs text-gray-300">{t}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- 悬停提示 ---- */}
      {hovered && !selected && (
        <div
          className="absolute glass-card px-3 py-2 z-20 pointer-events-none max-w-sm"
          style={{ left: hovered.x + 14, top: hovered.y + 14 }}
        >
          <p className="text-xs font-medium text-strong">{hovered.node.id}</p>
          <p
            className="text-[10px] uppercase tracking-wide"
            style={{ color: colorForType(hovered.node.properties?.entity_type) }}
          >
            {normalizeType(hovered.node.properties?.entity_type)}
          </p>
        </div>
      )}
    </div>
  )
}

function PanelButton({
  title, onClick, children, active,
}: { title: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={clsx(
        'px-2 py-2 transition-colors',
        active ? 'text-brand-400' : 'text-gray-500 hover:text-gray-300',
      )}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------- sigma 内部

/** 把坐标按钮的 DOM 事件接到 sigma 相机上。 */
function CameraApi() {
  const sigma = useSigma()
  useEffect(() => {
    const zi = () => sigma.getCamera().animatedZoom({ duration: 200 })
    const zo = () => sigma.getCamera().animatedUnzoom({ duration: 200 })
    const rs = () => sigma.getCamera().animatedReset({ duration: 300 })
    window.addEventListener('kg:zoomIn', zi)
    window.addEventListener('kg:zoomOut', zo)
    window.addEventListener('kg:reset', rs)
    return () => {
      window.removeEventListener('kg:zoomIn', zi)
      window.removeEventListener('kg:zoomOut', zo)
      window.removeEventListener('kg:reset', rs)
    }
  }, [sigma])
  return null
}

/**
 * 两种聚焦行为，都用 sigma 的 nodeReducer/edgeReducer（与 LightRAG 同机制）：
 *
 *   点击实体 → 隔离：只保留它的一跳邻域，其余节点与边【隐藏】，相机放大过去
 *   悬停实体 → 高亮：邻域保持原色并放大，其余【褪色】但仍可见
 *
 * "加粗"靠放大 size 实现 —— @sigma/node-border 的描边宽度是半径的固定比例，
 * 放大节点即等于加粗描边（该程序并不读取 highlighted 属性）。
 */
function GraphFocus({
  hoveredId, focusId, selectedId,
}: { hoveredId: string | null; focusId: string | null; selectedId: string | null }) {
  const sigma = useSigma()
  const setSettings = useSetSettings()
  const { theme } = useThemeStore()
  const isDark = theme === 'eye'

  // 聚焦时把相机对准邻域的包围盒，让被隔离出来的区域占满视野
  useEffect(() => {
    const graph = sigma.getGraph()

    // 退出聚焦 → 视野复位到全图
    if (!focusId || !graph.hasNode(focusId)) {
      sigma.getCamera().animatedReset({ duration: 500 })
      return
    }

    const ids = [focusId]
    graph.forEachNeighbor(focusId, (n) => ids.push(n))

    const xs = ids.map(n => Number(graph.getNodeAttribute(n, 'x')))
    const ys = ids.map(n => Number(graph.getNodeAttribute(n, 'y')))
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)

    // 邻域跨度 / 全图跨度 ≈ sigma 的 ratio（ratio 越小视野越近）
    let gMinX = Infinity, gMaxX = -Infinity, gMinY = Infinity, gMaxY = -Infinity
    graph.forEachNode(n => {
      const x = Number(graph.getNodeAttribute(n, 'x'))
      const y = Number(graph.getNodeAttribute(n, 'y'))
      gMinX = Math.min(gMinX, x); gMaxX = Math.max(gMaxX, x)
      gMinY = Math.min(gMinY, y); gMaxY = Math.max(gMaxY, y)
    })

    // sigma 的相机坐标是归一化的：图包围盒映射到以 0.5 为中心、较长边为 1 的
    // 正方形。所以要除以【较长边】而不是各自的宽高（归一化保持宽高比）。
    // 直接传原始图坐标会把相机移到图外，画布全空 —— 这是最初踩的坑。
    const gSpan = Math.max(gMaxX - gMinX, gMaxY - gMinY, 1)
    const areaSpan = Math.max(maxX - minX, maxY - minY, 1)

    const nx = 0.5 + ((minX + maxX) / 2 - (gMinX + gMaxX) / 2) / gSpan
    const ny = 0.5 + ((minY + maxY) / 2 - (gMinY + gMaxY) / 2) / gSpan
    // 1.8 是留白系数；上限 1 避免邻域比全图还大时反而拉远
    const ratio = Math.min(1, (areaSpan / gSpan) * 1.8)

    sigma.getCamera().animate({ x: nx, y: ny, ratio }, { duration: 600 })
  }, [focusId, sigma])

  useEffect(() => {
    const graph = sigma.getGraph()
    const target = focusId ?? hoveredId

    if (!target || !graph.hasNode(target)) {
      setSettings({ nodeReducer: null, edgeReducer: null })
      return
    }

    // 预先算好邻居集合。放进 reducer 里的话，图上每个节点每次刷新都会分配
    // 一次邻居数组再线性扫描 —— LightRAG 的注释里专门提到过这个坑。
    const neighbors = new Set<string>()
    graph.forEachNeighbor(target, (n) => neighbors.add(n))

    const isolating = Boolean(focusId)   // 点击进入隔离；悬停只褪色不隐藏
    const dimNode = isDark ? '#2b3040' : '#d8dee9'
    const dimEdge = isDark ? 'rgba(120,132,152,0.10)' : 'rgba(148,163,184,0.18)'

    setSettings({
      nodeReducer: (node, data) => {
        const related = node === target || neighbors.has(node)
        if (!related) {
          // 隔离模式下隐藏无关节点；悬停模式下只褪色
          return isolating ? { ...data, hidden: true } : { ...data, color: dimNode }
        }
        return {
          ...data,
          hidden: false,
          // 聚焦点放大更多，邻居适度放大
          size: (Number(data.size) || 6) * (node === target ? 1.9 : 1.45),
          borderColor: node === selectedId ? HIGHLIGHT_COLOR : NODE_BORDER_COLOR,
        }
      },
      edgeReducer: (edge, data) => {
        // 不用 graph.extremities()：它每条边都会分配一个数组
        const touches = graph.source(edge) === target || graph.target(edge) === target
        if (touches) {
          return { ...data, hidden: false, color: HIGHLIGHT_COLOR, size: Math.max(2, Number(data.size) || 1) }
        }
        return isolating
          ? { ...data, hidden: true }
          : { ...data, hidden: false, color: dimEdge, size: 0.5 }
      },
    })
  }, [focusId, hoveredId, selectedId, sigma, setSettings, isDark])

  return null
}

function GraphLoader({ data, layout }: { data: GraphData; layout: LayoutName }) {
  const loadGraph = useLoadGraph()

  useEffect(() => {
    const graph = new Graph({ multi: true, type: 'directed' })
    const degree: Record<string, number> = {}

    // 先环形撒点：ForceAtlas2 需要初始铺开，否则会挤成一团分不开
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
        // node-border 程序读这个属性画那圈描边
        borderColor: NODE_BORDER_COLOR,
      })
    })

    for (const e of data.edges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue
      degree[e.source] = (degree[e.source] || 0) + 1
      degree[e.target] = (degree[e.target] || 0) + 1
      if (e.source === e.target || graph.hasEdge(e.source, e.target)) continue
      graph.addEdge(e.source, e.target, {
        size: Math.max(0.4, Math.min(2, Number(e.properties?.weight) || 1)),
      })
    }

    graph.forEachNode(node => {
      graph.setNodeAttribute(node, 'size', 5 + Math.sqrt(degree[node] || 0) * 4)
    })

    if (graph.order > 1) {
      switch (layout) {
        case 'circular':   circular.assign(graph); break
        case 'random':     random.assign(graph); break
        case 'circlepack': circlepack.assign(graph); break
        default:
          forceAtlas2.assign(graph, {
            iterations: 300,
            settings: { gravity: 3, scalingRatio: 30, adjustSizes: true, barnesHutOptimize: true },
          })
      }
    }

    loadGraph(graph)
  }, [data, layout, loadGraph])

  return null
}

function FitOnLoad({ signature }: { signature: string }) {
  const sigma = useSigma()
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        sigma.getCamera().animatedReset({ duration: 400 })
      } catch {
        // Sigma 尚未挂载完成，忽略
      }
    }, 80)
    return () => clearTimeout(t)
  }, [signature, sigma])

  return null
}

function GraphEvents({
  onHover, onHoverId, onSelect, onClearFocus,
}: {
  onHover: (v: Hovered | null) => void
  onHoverId: (id: string | null) => void
  onSelect: (n: GraphNode | null) => void
  onClearFocus: () => void
}) {
  const registerEvents = useRegisterEvents()
  const sigma = useSigma()
  // sigma 点击节点时会同时派发 clickNode 和 clickStage，于是"点节点"会立刻被
  // clickStage 当成"点空白"而取消聚焦。用一个极短的时间窗把这一对事件区分开。
  const lastNodeClickAt = useRef(0)

  // Esc 退出聚焦隔离
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClearFocus() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClearFocus])

  useEffect(() => {
    registerEvents({
      enterNode: ({ node }) => {
        const attrs = sigma.getGraph().getNodeAttributes(node)
        const pos = sigma.graphToViewport({ x: attrs.x as number, y: attrs.y as number })
        onHoverId(node)
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
      leaveNode: () => { onHover(null); onHoverId(null) },
      clickNode: ({ node }) => {
        lastNodeClickAt.current = Date.now()
        const attrs = sigma.getGraph().getNodeAttributes(node)
        // 相机一律交给 GraphFocus —— 它会把邻域包围盒换算成 sigma 的归一化
        // 相机坐标。这里绝不能再动相机：attrs.x/y 是【原始图坐标】，直接传进去
        // 会把相机移到图外，画布全空（重复点击同一节点时尤其明显，因为那时
        // GraphFocus 的 effect 不会重跑，没有正确动画来覆盖这个错误动作）。
        onSelect({
          id: node,
          properties: {
            entity_type: attrs.entityType as string,
            description: attrs.description as string,
          },
        })
      },
      // 点击空白处退出聚焦（同一节点触发的 clickStage 已被上面的时间窗滤掉）
      clickStage: () => {
        if (Date.now() - lastNodeClickAt.current < 250) return
        onClearFocus()
      },
    })
  }, [registerEvents, sigma, onHover, onHoverId, onSelect, onClearFocus])

  return null
}
