import type { GraphEdge, GraphNode } from '@/components/KnowledgeGraph'

/** LightRAG joins multi-valued fields with this literal separator. */
const SEP = '<SEP>'

// Chunk keys are `{document_id}-chunk-{NNN}` (see LightRAG utils_pipeline), so a
// chunk id embeds the full document id it came from.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHUNK_MARK = '-chunk-'

export interface SourceRef {
  documentId: string
  /** Fully-qualified document id in the source row, when known. */
  chunkIds: string[]
  /** Display name, stripped of the ingest-time uniqueness suffix. */
  name: string
}

function split(value: unknown): string[] {
  return String(value ?? '')
    .split(SEP)
    .map(s => s.trim())
    .filter(Boolean)
}

function docIdOfChunk(chunkId: string): string | null {
  const at = chunkId.indexOf(CHUNK_MARK)
  if (at < 0) return null
  const docId = chunkId.slice(0, at)
  return UUID_RE.test(docId) ? docId : null
}

/** Strip the `__<8hex>` uniqueness suffix and any directory, for display. */
export function fileName(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || filePath
  return base.replace(/__[0-9a-f]{8}(?=\.[^.]+$|$)/, '')
}

/**
 * The documents an entity was extracted from, grouped by owning document.
 *
 * `source_id` lists the chunk keys (which carry the document id); `file_path`
 * lists the ingest file paths (which carry the same id as an `__<8hex>` suffix).
 * We group by document id and borrow the file name for display.
 */
export function entitySources(node: GraphNode): SourceRef[] {
  const props = node.properties ?? {}

  // document id (from chunk keys) -> chunk keys
  const chunksByDoc = new Map<string, string[]>()
  for (const chunkId of split(props.source_id)) {
    const docId = docIdOfChunk(chunkId)
    if (!docId) continue
    const list = chunksByDoc.get(docId)
    if (list) list.push(chunkId)
    else chunksByDoc.set(docId, [chunkId])
  }

  // 8-hex id prefix -> display name
  const nameByPrefix = new Map<string, string>()
  for (const fp of split(props.file_path)) {
    const m = /__([0-9a-f]{8})(?=\.[^.]+$|$)/.exec(fp)
    if (m) nameByPrefix.set(m[1], fileName(fp))
  }

  return Array.from(chunksByDoc.entries()).map(([documentId, chunkIds]) => ({
    documentId,
    chunkIds,
    name: nameByPrefix.get(documentId.slice(0, 8)) || fileName(documentId),
  }))
}

export interface Relation {
  /** The entity at the other end of this relation. */
  neighborId: string
  keywords: string
  description: string
  weight: number
}

/** Relations incident to `nodeId`, with the neighbour and its relation text. */
export function relationsOf(nodeId: string, edges: GraphEdge[]): Relation[] {
  const out: Relation[] = []
  for (const e of edges) {
    if (e.source !== nodeId && e.target !== nodeId) continue
    out.push({
      neighborId: e.source === nodeId ? e.target : e.source,
      keywords: String(e.properties?.keywords || ''),
      description: String(e.properties?.description || ''),
      weight: Number(e.properties?.weight) || 1,
    })
  }
  // Strongest (highest weight) first, then alphabetically for stability.
  out.sort((a, b) => b.weight - a.weight || a.neighborId.localeCompare(b.neighborId))
  return out
}
