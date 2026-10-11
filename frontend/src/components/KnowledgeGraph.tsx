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
  FileText, Loader2, Link2,
} from 'lucide-react'
import clsx from 'clsx'
import { useThemeStore } from '@/store/themeStore'
import { chatApi } from '@/services/api'
import DocumentViewer from '@/components/DocumentViewer'
import { entitySources, relationsOf, type SourceRef } from '@/lib/provenance'

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

// ---- 实体类型收敛到 8 类 + Okabe–Ito 色盲友好色板 ----
//
// 原始图谱有 14+ 种 entity_type，且长尾极重（实测 artifact/method/concept 三类
// 就占近七成，尾部 role/group/platform 各只有 1–3 个）。原调色板里 concept(红) /
// method(深红) / location(橙) 几乎分不出，图例也读不过来。
// 这里按语义合并成 8 类：图例读得懂、颜色分得开，且全部取自 Okabe–Ito
// （色盲安全）。归不了类的一律进 other（含 unknown），而不是各占一色。
export const CANONICAL_TYPES = [
  'person', 'organization', 'location', 'event', 'concept', 'method', 'artifact', 'other',
] as const
export type EntityType = (typeof CANONICAL_TYPES)[number]

const TYPE_LABELS: Record<EntityType, string> = {
  person: '人物',
  organization: '组织',
  location: '地点',
  event: '事件',
  concept: '概念',
  method: '方法',
  artifact: '制品',
  other: '其他',
}

// Okabe–Ito 8 色。原调色板的黄对浅色背景不友好，artifact 取其暗一档的金色。
const TYPE_COLORS: Record<EntityType, string> = {
  person: '#0072B2',
  organization: '#009E73',
  location: '#E69F00',
  event: '#56B4E9',
  concept: '#CC79A7',
  method: '#D55E00',
  artifact: '#C8A415',
  other: '#8A8F98',
}

const DEFAULT_NODE_COLOR = TYPE_COLORS.other

// 原始类型（已去掉空白/下划线/连字符）→ 收敛后的 8 类。未命中一律 other。
const TYPE_ALIASES: Record<string, EntityType> = {
  person: 'person', people: 'person', human: 'person',
  organization: 'organization', org: 'organization', company: 'organization',
  institution: 'organization', university: 'organization', school: 'organization',
  government: 'organization', group: 'organization',
  location: 'location', geography: 'location', naturalobject: 'location',
  place: 'location', region: 'location',
  event: 'event', activity: 'event',
  concept: 'concept', content: 'concept', data: 'concept', idea: 'concept',
  topic: 'concept', field: 'concept', category: 'concept', subject: 'concept',
  method: 'method', technique: 'method', algorithm: 'method', model: 'method',
  approach: 'method', technology: 'method', process: 'method', tool: 'method',
  artifact: 'artifact', product: 'artifact', system: 'artifact', platform: 'artifact',
  software: 'artifact', device: 'artifact', dataset: 'artifact', document: 'artifact',
}

export function normalizeType(raw?: string): EntityType {
  const t = (raw || '').toLowerCase().replace(/[\s_-]/g, '')
  return TYPE_ALIASES[t] || 'other'
}

export function typeLabel(raw?: string): string {
  return TYPE_LABELS[normalizeType(raw)]
}

export function colorForType(raw?: string): string {
  return TYPE_COLORS[normalizeType(raw)] || DEFAULT_NODE_COLOR
}

const NODE_BORDER_COLOR = '#EEEEEE'
const EDGE_COLOR_DARK = '#888888'
const EDGE_COLOR_LIGHT = '#d3d3d3'
const LABEL_COLOR_DARK = '#FFFFFF'
const LABEL_COLOR_LIGHT = '#000000'
const HIGHLIGHT_COLOR = '#F57F17'
// 聚焦时非邻域节点/边的褪色（保留上下文，而不是直接隐藏）
const DIM_NODE_DARK = '#2b3040'
const DIM_NODE_LIGHT = '#d8dee9'
const DIM_EDGE_DARK = 'rgba(120,132,152,0.16)'
const DIM_EDGE_LIGHT = 'rgba(148,163,184,0.22)'
// 概览时只给连接度最高的这批节点显示标签，其余缩放/hover 时才出现
const LABEL_TOP_FRACTION = 0.15
const LABEL_TOP_MIN = 20
const LABEL_TOP_MAX = 60
// 相机 ratio 低于此值视为「已缩放」，揭示全部标签
const ZOOM_REVEAL_RATIO = 0.5

type LayoutName = 'force' | 'circular' | 'circlepack' | 'random'

const LAYOUTS: { id: LayoutName; label: string }[] = [
  { id: 'force', label: '力导向' },
  { id: 'circular', label: '环形' },
  { id: 'circlepack', label: '圆堆积' },
  { id: 'random', label: '随机' },
]

type Hovered = { node: GraphNode; x: number; y: number; degree: number }

/** 实体-关系图谱：外观与控件对齐 LightRAG 自带前端。 */
export default function KnowledgeGraph({ data }: { data: GraphData }) {
  const { theme } = useThemeStore()
  const isDark = theme === 'eye'

  const containerRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<Hovered | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  // 点击实体后进入「聚焦」：邻域高亮、其余褪色（保留上下文），相机放大过去
  const [focusId, setFocusId] = useState<string | null>(null)
  const [showLabels, setShowLabels] = useState(true)
  const [showLegend, setShowLegend] = useState(true)
  // 被用户在图例里点掉的实体类型
  const [hiddenTypes, setHiddenTypes] = useState<Set<EntityType>>(new Set())
  const [layout, setLayout] = useState<LayoutName>('force')
  const [fullscreen, setFullscreen] = useState(false)
  const [query, setQuery] = useState('')
  // Provenance 侧栏：来源文档正在拉取 chunk 原文 / 已打开的文档视图
  const [sourceLoading, setSourceLoading] = useState<string | null>(null)
  const [viewer, setViewer] = useState<{ documentId: string; title: string; highlights: string[] } | null>(null)

  // 每个节点的度数（= 连接数）。既决定节点大小，也决定概览时谁显示标签。
  const degreeById = useMemo(() => {
    const deg: Record<string, number> = {}
    for (const e of data.edges || []) {
      if (e.source === e.target) continue
      deg[e.source] = (deg[e.source] || 0) + 1
      deg[e.target] = (deg[e.target] || 0) + 1
    }
    return deg
  }, [data])

  // 概览只给连接度最高的这批节点显示标签 —— 334 个全显就是毛球，任何布局都救不了。
  const importantIds = useMemo(() => {
    const ids = (data.nodes || []).map(n => n.id)
    ids.sort((a, b) => (degreeById[b] || 0) - (degreeById[a] || 0))
    const k = Math.min(LABEL_TOP_MAX, Math.max(LABEL_TOP_MIN, Math.round(ids.length * LABEL_TOP_FRACTION)))
    return new Set(ids.slice(0, k))
  }, [data, degreeById])

  // 类型 → 计数，用于图例（按计数降序）
  const typeCounts = useMemo(() => {
    const counts = new Map<EntityType, number>()
    for (const n of data.nodes || []) {
      const t = normalizeType(n.properties?.entity_type)
      counts.set(t, (counts.get(t) || 0) + 1)
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [data])

  const toggleType = useCallback((t: EntityType) => {
    setHiddenTypes(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }, [])

  // 选中的实体：GraphEvents 只带回了 id，完整的 properties（source_id /
  // file_path，溯源要用）得从原始 payload 里按 id 取回。
  const selectedNode = useMemo(
    () => (selected ? data.nodes.find(n => n.id === selected.id) ?? selected : null),
    [selected, data],
  )
  const relations = useMemo(
    () => (selected ? relationsOf(selected.id, data.edges) : []),
    [selected, data],
  )
  const sources = useMemo(
    () => (selectedNode ? entitySources(selectedNode) : []),
    [selectedNode],
  )

  // 点来源文档：拉该实体关联 chunk 的原文，交给 DocumentViewer 精确高亮
  const openSource = useCallback(async (src: SourceRef) => {
    setSourceLoading(src.documentId)
    try {
      const { data: resp } = await chatApi.getChunks(src.chunkIds)
      const highlights = src.chunkIds.map(id => resp.chunks[id]).filter(Boolean)
      setViewer({ documentId: src.documentId, title: src.name, highlights })
    } catch {
      // 拉不到 chunk 原文也照样打开文档，只是没有高亮
      setViewer({ documentId: src.documentId, title: src.name, highlights: [] })
    } finally {
      setSourceLoading(null)
    }
  }, [])

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
          // 边标签只在 hover/聚焦时由 reducer 填 label，平时为空串不渲染
          renderEdgeLabels: true,
          edgeLabelSize: 11,
          edgeLabelColor: { color: isDark ? LABEL_COLOR_DARK : LABEL_COLOR_LIGHT },
          hideEdgesOnMove: true,
          labelGridCellSize: 60,
          // 标签是否显示由 reducer 的 LOD 决定，这里不设尺寸门槛
          labelRenderedSizeThreshold: 0,
          defaultEdgeColor: isDark ? EDGE_COLOR_DARK : EDGE_COLOR_LIGHT,
          labelColor: { color: isDark ? LABEL_COLOR_DARK : LABEL_COLOR_LIGHT },
        }}
      >
        <GraphLoader data={data} layout={layout} degreeById={degreeById} />
        <FitOnLoad signature={`${data.nodes.length}-${data.edges.length}-${layout}`} />
        <GraphEvents
          onHover={setHovered}
          onHoverId={setHoveredId}
          onSelect={(n) => { setSelected(n); setFocusId(n?.id ?? null) }}
          onClearFocus={() => { setFocusId(null); setSelected(null) }}
        />
        <GraphStyle
          focusId={focusId}
          hoveredId={hoveredId}
          selectedId={selected?.id ?? null}
          importantIds={importantIds}
          hiddenTypes={hiddenTypes}
          showLabels={showLabels}
        />
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

      {/* ---- 聚焦提示（邻域高亮、其余褪色，保留上下文） ---- */}
      {focusId && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 glass-card px-4 py-2 flex items-center gap-3">
          <span className="text-xs text-gray-400">聚焦中：高亮相邻实体，其余已淡化</span>
          <button
            onClick={() => { setFocusId(null); setSelected(null) }}
            className="text-xs text-brand-400 hover:text-brand-300 transition-colors"
          >
            退出（Esc）
          </button>
        </div>
      )}

      {/* ---- 截断提示：当前是 top-degree 切片，不是全图 ---- */}
      {data.is_truncated && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 glass-card px-3 py-1.5">
          <span className="text-[11px] text-amber-300/90">
            已按连接度截断：仅显示前 {data.nodes.length} 个实体
          </span>
        </div>
      )}

      {/* ---- 右上：溯源面板（属性 + 关系 + 来源文档） ---- */}
      {selected && selectedNode && (
        <div className="absolute top-3 right-3 z-10 glass-card w-80 max-h-[72%] overflow-y-auto">
          <div className="flex items-start justify-between gap-2 px-4 pt-4">
            <p className="text-sm font-medium text-strong break-all">{selected.id}</p>
            <button
              onClick={() => { setSelected(null); setFocusId(null) }}
              className="text-gray-500 hover:text-gray-300 flex-shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <p
            className="text-[10px] tracking-wide px-4 mt-1 mb-2"
            style={{ color: colorForType(selectedNode.properties?.entity_type) }}
          >
            {typeLabel(selectedNode.properties?.entity_type)} · 连接度 {degreeById[selected.id] || 0}
          </p>

          {selectedNode.properties?.description && (
            <p className="text-xs text-gray-400 leading-relaxed whitespace-pre-wrap px-4 pb-3">
              {String(selectedNode.properties.description)}
            </p>
          )}

          {/* 关系：点邻居即聚焦到它 */}
          {relations.length > 0 && (
            <div className="border-t border-white/5 px-4 py-3">
              <p className="text-xs text-gray-400 font-medium mb-2 flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5" /> 关系 <span className="text-gray-600 font-normal">{relations.length}</span>
              </p>
              <div className="space-y-1">
                {relations.slice(0, 40).map((r, i) => (
                  <button
                    key={`${r.neighborId}-${i}`}
                    onClick={() => { setSelected({ id: r.neighborId, properties: {} }); setFocusId(r.neighborId) }}
                    className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors"
                    title={r.description || r.keywords}
                  >
                    <span className="text-xs text-gray-200 break-all">{r.neighborId}</span>
                    {r.keywords && (
                      <span className="block text-[10px] text-brand-300/80 truncate mt-0.5">{r.keywords}</span>
                    )}
                  </button>
                ))}
                {relations.length > 40 && (
                  <p className="text-[10px] text-gray-600 px-2 pt-1">还有 {relations.length - 40} 条未显示</p>
                )}
              </div>
            </div>
          )}

          {/* 来源：点开原文并高亮该实体关联的 chunk */}
          <div className="border-t border-white/5 px-4 py-3">
            <p className="text-xs text-gray-400 font-medium mb-2 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" /> 来源文档 <span className="text-gray-600 font-normal">{sources.length}</span>
            </p>
            {sources.length === 0 ? (
              <p className="text-[11px] text-gray-600 px-1">该实体没有可追溯的来源文档。</p>
            ) : (
              <div className="space-y-1">
                {sources.map(src => (
                  <button
                    key={src.documentId}
                    onClick={() => void openSource(src)}
                    disabled={sourceLoading !== null}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors text-left disabled:opacity-50"
                    title="打开原文并高亮关联片段"
                  >
                    {sourceLoading === src.documentId
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-400 flex-shrink-0" />
                      : <FileText className="w-3.5 h-3.5 text-brand-400 flex-shrink-0" />}
                    <span className="text-xs text-gray-200 truncate flex-1">{src.name}</span>
                    <span className="text-[10px] text-gray-500 flex-shrink-0">{src.chunkIds.length} 段</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- 溯源：打开来源文档并高亮 ---- */}
      {viewer && (
        <DocumentViewer
          documentId={viewer.documentId}
          title={viewer.title}
          highlights={viewer.highlights}
          onClose={() => setViewer(null)}
        />
      )}

      {/* ---- 右下：图例（可点击筛选）+ 大小图例 ---- */}
      {showLegend && (
        <div className="absolute bottom-3 right-3 z-10 glass-card px-4 py-3 max-h-[60%] overflow-y-auto">
          <p className="text-xs text-gray-400 mb-2 font-medium">
            实体类型 <span className="text-gray-600 font-normal">（点击隐藏/显示）</span>
          </p>
          <div className="space-y-1">
            {typeCounts.map(([t, n]) => {
              const off = hiddenTypes.has(t)
              return (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={clsx(
                    'w-full flex items-center gap-2 px-1.5 py-1 rounded-lg transition-colors text-left',
                    off ? 'opacity-40 hover:opacity-70' : 'hover:bg-white/5',
                  )}
                  title={off ? '点击显示该类' : '点击隐藏该类'}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ background: colorForType(t), boxShadow: `0 0 0 1.5px ${NODE_BORDER_COLOR}` }}
                  />
                  <span className={clsx('text-xs flex-1', off ? 'text-gray-500 line-through' : 'text-gray-300')}>
                    {typeLabel(t)}
                  </span>
                  <span className="text-[10px] text-gray-500">{n}</span>
                </button>
              )
            })}
          </div>

          <div className="border-t border-white/5 mt-3 pt-2">
            <p className="text-xs text-gray-400 mb-1.5 font-medium">节点大小</p>
            <div className="flex items-center gap-2 px-1.5">
              <span className="w-2 h-2 rounded-full bg-gray-500" />
              <span className="w-4 h-4 rounded-full bg-gray-500" />
              <span className="text-[10px] text-gray-500">连接度低 → 高</span>
            </div>
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
            className="text-[10px] tracking-wide"
            style={{ color: colorForType(hovered.node.properties?.entity_type) }}
          >
            {typeLabel(hovered.node.properties?.entity_type)} · 连接度 {hovered.degree}
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
 * 一个组件统管 node/edge 的渲染样式（sigma 只允许一份 reducer，所以 LOD、类型
 * 筛选、聚焦褪色必须合成一处）：
 *
 *   LOD      概览只显示重要节点的标签；放大或 hover/聚焦时揭示其余
 *   类型筛选  图例点掉的类型整类隐藏，连带其边
 *   聚焦      邻域放大高亮、其余【褪色】而非隐藏（保留上下文），边显示关系关键词
 *
 * "加粗"靠放大 size 实现 —— @sigma/node-border 的描边宽度是半径的固定比例，
 * 放大节点即等于加粗描边（该程序并不读取 highlighted 属性）。
 */
function GraphStyle({
  focusId, hoveredId, selectedId, importantIds, hiddenTypes, showLabels,
}: {
  focusId: string | null
  hoveredId: string | null
  selectedId: string | null
  importantIds: Set<string>
  hiddenTypes: Set<EntityType>
  showLabels: boolean
}) {
  const sigma = useSigma()
  const setSettings = useSetSettings()
  const { theme } = useThemeStore()
  const isDark = theme === 'eye'

  // 相机 ratio < 1 表示已放大，低于阈值即揭示全部标签（LOD 第二级）。
  // 只订阅布尔量：相机 'updated' 每帧都触发，若直接存 ratio 会让 reducer
  // 在平移/缩放过程中每帧重跑一遍整图。
  const [zoomedIn, setZoomedIn] = useState(false)
  useEffect(() => {
    const camera = sigma.getCamera()
    const onUpdate = () => {
      const z = camera.ratio < ZOOM_REVEAL_RATIO
      setZoomedIn(prev => (prev === z ? prev : z))
    }
    onUpdate()
    camera.on('updated', onUpdate)
    return () => { camera.off('updated', onUpdate) }
  }, [sigma])

  // 聚焦时把相机对准邻域的包围盒，让邻域占满视野
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
    const hasTarget = Boolean(target && graph.hasNode(target as string))

    // 预先算好邻居集合。放进 reducer 里的话，图上每个节点每次刷新都会分配
    // 一次邻居数组再线性扫描 —— LightRAG 的注释里专门提到过这个坑。
    const neighbors = new Set<string>()
    if (hasTarget) graph.forEachNeighbor(target as string, (n) => neighbors.add(n))

    const dimNode = isDark ? DIM_NODE_DARK : DIM_NODE_LIGHT
    const dimEdge = isDark ? DIM_EDGE_DARK : DIM_EDGE_LIGHT
    const hidden = (n: string) =>
      hiddenTypes.has(graph.getNodeAttribute(n, 'entityType') as EntityType)

    setSettings({
      nodeReducer: (node, data) => {
        // 图例点掉的类型：整类隐藏
        if (hidden(node)) return { ...data, hidden: true }

        const related = hasTarget && (node === target || neighbors.has(node))
        if (hasTarget && !related) {
          // 聚焦/悬停时其余节点【褪色】而非隐藏，保留上下文
          return { ...data, hidden: false, label: '', color: dimNode, borderColor: dimNode }
        }
        // LOD：重要节点 / 邻域 / 已放大 → 显示标签
        const showLabel = showLabels && (importantIds.has(node) || related || zoomedIn)
        const baseSize = Number(data.size) || 6
        return {
          ...data,
          hidden: false,
          label: showLabel ? String(data.label ?? '') : '',
          // 聚焦点放大更多，邻居适度放大
          size: hasTarget ? baseSize * (node === target ? 1.9 : 1.45) : baseSize,
          borderColor: node === selectedId ? HIGHLIGHT_COLOR : NODE_BORDER_COLOR,
        }
      },
      edgeReducer: (edge, data) => {
        // 端点属于被隐藏的类型 → 一并隐藏（不用 extremities()，它每条边都分配数组）
        if (hidden(graph.source(edge)) || hidden(graph.target(edge))) {
          return { ...data, hidden: true }
        }
        const touches = hasTarget &&
          (graph.source(edge) === target || graph.target(edge) === target)
        if (touches) {
          // 高亮边标注关系关键词。LightRAG 的关系没有单谓词，语义在
          // keywords / description 里 —— 这就是「边上的谓词」。
          const raw = String(data.keywords || data.description || '')
          return {
            ...data,
            hidden: false,
            color: HIGHLIGHT_COLOR,
            size: Math.max(2, Number(data.size) || 1),
            label: raw.length > 24 ? `${raw.slice(0, 24)}…` : raw,
          }
        }
        if (!hasTarget) return { ...data, hidden: false, label: '' }
        return { ...data, hidden: false, color: dimEdge, size: 0.5, label: '' }
      },
    })
  }, [focusId, hoveredId, selectedId, sigma, setSettings, isDark, importantIds, hiddenTypes, showLabels, zoomedIn])

  return null
}

function GraphLoader({
  data, layout, degreeById,
}: { data: GraphData; layout: LayoutName; degreeById: Record<string, number> }) {
  const loadGraph = useLoadGraph()

  useEffect(() => {
    const graph = new Graph({ multi: true, type: 'directed' })

    // 先环形撒点：ForceAtlas2 需要初始铺开，否则会挤成一团分不开
    const radius = 20 + data.nodes.length * 1.5
    data.nodes.forEach((n, i) => {
      const angle = (i / Math.max(data.nodes.length, 1)) * Math.PI * 2
      const degree = degreeById[n.id] || 0
      graph.addNode(n.id, {
        label: n.id,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        // 大小 ∝ √连接度 —— 语义见右下图例「节点大小」
        size: 5 + Math.sqrt(degree) * 4,
        degree,
        entityType: normalizeType(n.properties?.entity_type),
        description: n.properties?.description || '',
        color: colorForType(n.properties?.entity_type),
        // node-border 程序读这个属性画那圈描边
        borderColor: NODE_BORDER_COLOR,
      })
    })

    for (const e of data.edges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue
      if (e.source === e.target || graph.hasEdge(e.source, e.target)) continue
      graph.addEdge(e.source, e.target, {
        size: Math.max(0.4, Math.min(2, Number(e.properties?.weight) || 1)),
        // 保留关系语义：hover/聚焦时由 reducer 填进 label 显示
        keywords: e.properties?.keywords || '',
        description: e.properties?.description || '',
        // 平时空串 → sigma 不渲染边标签
        label: '',
      })
    }

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
  }, [data, layout, loadGraph, degreeById])

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
          degree: Number(attrs.degree) || 0,
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
