import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, FileText, Loader2, X } from 'lucide-react'
import { chatApi, getApiError } from '@/services/api'
import { findAllHighlightRanges } from '@/lib/highlight'

interface Props {
  /** Document to open; null renders a "cannot link" notice. */
  documentId: string | null
  title: string
  /** Passage texts to locate and highlight inside the document. */
  highlights: string[]
  onClose: () => void
}

/**
 * Full-screen overlay showing a source document with one or more retrieved
 * passages highlighted in place. Opened from the RAG panel (chat) and from the
 * graph provenance panel (knowledge graph).
 */
export default function DocumentViewer({ documentId, title, highlights, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(!!documentId)
  const markRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!documentId) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    chatApi.getDocument(documentId)
      .then(({ data }) => { if (!cancelled) setContent(data.content ?? '') })
      .catch((e) => { if (!cancelled) setError(getApiError(e, '加载文档失败')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [documentId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ranges = useMemo(
    () => (content ? findAllHighlightRanges(content, highlights) : []),
    [content, highlights],
  )

  // Bring the first highlighted passage into view once the document has rendered.
  useEffect(() => {
    if (ranges.length) markRef.current?.scrollIntoView({ block: 'center' })
  }, [ranges, content])

  // Walk the document, wrapping each matched range in a <mark>.
  const parts = useMemo(() => {
    if (!content || !ranges.length) return null
    const nodes: React.ReactNode[] = []
    let cursor = 0
    ranges.forEach((r, i) => {
      if (r.start > cursor) nodes.push(content.slice(cursor, r.start))
      nodes.push(
        <mark
          key={i}
          ref={i === 0 ? markRef : undefined}
          className="bg-brand-500/40 text-gray-50 rounded px-0.5 -mx-0.5"
        >
          {content.slice(r.start, r.end)}
        </mark>,
      )
      cursor = r.end
    })
    if (cursor < content.length) nodes.push(content.slice(cursor))
    return nodes
  }, [content, ranges])

  const notFound = Boolean(content) && highlights.length > 0 && ranges.length === 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`文档：${title}`}
        className="glass-card w-full max-w-3xl h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5 flex-shrink-0">
          <FileText className="w-4 h-4 text-brand-400 flex-shrink-0" />
          <h3 className="text-sm font-semibold text-strong truncate flex-1" title={title}>
            {title}
          </h3>
          {ranges.length > 0 && (
            <span className="text-[11px] text-gray-500 flex-shrink-0">已高亮 {ranges.length} 处</span>
          )}
          <button onClick={onClose} className="btn-ghost p-1.5" title="关闭（Esc）">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-gray-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> 加载文档…
            </div>
          ) : error ? (
            <div className="py-16 text-center text-sm text-red-400">{error}</div>
          ) : !documentId ? (
            <div className="py-16 text-center text-sm text-gray-500">
              该片段无法回连到具体文档，暂不支持查看原文。
            </div>
          ) : (
            <>
              {notFound && (
                <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-200/90 leading-relaxed">
                    未能在原文中精确定位该片段（文本可能已被规范化或改写），以下为片段内容：
                    {highlights.map((h, i) => (
                      <p key={i} className="mt-2 text-gray-300 whitespace-pre-wrap">{h}</p>
                    ))}
                  </div>
                </div>
              )}
              <div className="text-sm leading-relaxed text-gray-300 whitespace-pre-wrap break-words">
                {parts ?? content}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
