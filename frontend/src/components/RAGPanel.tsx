import { X, FileText, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { RAGContext } from '@/types'

interface Props {
  contexts: RAGContext[]
  onClose: () => void
}

export default function RAGPanel({ contexts, onClose }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <aside className="w-80 flex-shrink-0 glass border-l border-white/5 flex flex-col animate-slide-up overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div>
          <h3 className="text-sm font-semibold text-white">Retrieved Sources</h3>
          <p className="text-xs text-gray-500">{contexts.length} relevant chunks</p>
        </div>
        <button onClick={onClose} className="btn-ghost p-1.5">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {contexts.map((ctx, i) => (
          <div key={ctx.chunk_id} className="bg-surface-100 rounded-xl border border-white/5 overflow-hidden">
            <button
              onClick={() => setExpanded(expanded === ctx.chunk_id ? null : ctx.chunk_id)}
              className="w-full flex items-center gap-3 p-3 hover:bg-white/5 transition-colors text-left"
            >
              <FileText className="w-4 h-4 text-brand-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-200 truncate">{ctx.document_title}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <div className="flex-1 h-1 bg-surface-300 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand-500 rounded-full"
                      style={{ width: `${ctx.similarity_score * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-500 flex-shrink-0">
                    {(ctx.similarity_score * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
              {expanded === ctx.chunk_id
                ? <ChevronDown className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
                : <ChevronRight className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
              }
            </button>
            {expanded === ctx.chunk_id && (
              <div className="px-3 pb-3 border-t border-white/5 pt-2">
                <p className="text-xs text-gray-400 leading-relaxed line-clamp-6">{ctx.content}</p>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="p-3 border-t border-white/5">
        <p className="text-xs text-gray-600 text-center">
          Powered by vector similarity search
        </p>
      </div>
    </aside>
  )
}
