import { useRef, useState } from 'react'
import { FileText, Loader2, Upload, X } from 'lucide-react'
import clsx from 'clsx'
import { chatApi, getApiError } from '@/services/api'

const ACCEPTED_FILE_TYPES = '.pdf,.docx,.md,.markdown,.txt'

/** Upload a document to the knowledge base — by file or pasted text. */
export default function DocumentUploader({ onUploaded }: { onUploaded?: () => void }) {
  const [mode, setMode] = useState<'file' | 'paste'>('file')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const reset = () => {
    setTitle(''); setContent(''); setFile(null); setError('')
    if (fileInput.current) fileInput.current.value = ''
  }

  const pick = (picked: File | null | undefined) => {
    if (!picked) return
    setError('')
    setFile(picked)
  }

  const submit = async () => {
    setUploading(true); setError('')
    try {
      if (mode === 'file') {
        if (!file) return
        await chatApi.uploadDocumentFile(file, title.trim() || undefined)
      } else {
        if (!title.trim() || !content.trim()) return
        await chatApi.uploadDocument({ title, content, doc_type: 'text' })
      }
      reset()
      onUploaded?.()
    } catch (e: unknown) {
      setError(getApiError(e, 'Upload failed. Please try again.'))
    }
    setUploading(false)
  }

  const tabClass = (active: boolean) =>
    clsx(
      'flex-1 py-2 rounded-lg text-sm font-medium transition-all',
      active ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-white/5',
    )

  const canSubmit = mode === 'file' ? !!file : !!title.trim() && !!content.trim()

  return (
    <div className="glass-card p-5 space-y-3">
      <div className="flex gap-2 p-1 bg-surface-100 rounded-xl border border-white/5">
        <button onClick={() => { setMode('file'); setError('') }} className={tabClass(mode === 'file')}>
          Upload file
        </button>
        <button onClick={() => { setMode('paste'); setError('') }} className={tabClass(mode === 'paste')}>
          Paste text
        </button>
      </div>

      <input
        className="input-field"
        placeholder={mode === 'file' ? 'Title (optional — defaults to filename)' : 'Document title'}
        value={title}
        onChange={e => setTitle(e.target.value)}
      />

      {mode === 'file' ? (
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files?.[0]) }}
          onClick={() => fileInput.current?.click()}
          className={clsx(
            'flex flex-col items-center justify-center gap-2 py-7 rounded-xl border border-dashed cursor-pointer transition-all',
            dragging ? 'border-brand-500/60 bg-brand-600/10' : 'border-white/10 hover:border-white/20',
          )}
        >
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            accept={ACCEPTED_FILE_TYPES}
            onChange={e => pick(e.target.files?.[0])}
          />
          {file ? (
            <>
              <FileText className="w-5 h-5 text-brand-400" />
              <p className="text-sm text-gray-200 truncate max-w-full px-4">{file.name}</p>
              <p className="text-xs text-gray-500 flex items-center gap-2">
                {(file.size / 1024).toFixed(0)} KB · 点击更换
              </p>
            </>
          ) : (
            <>
              <Upload className="w-5 h-5 text-gray-500" />
              <p className="text-sm text-gray-400">拖拽文件到此处，或点击选择</p>
              <p className="text-xs text-gray-600">支持 .pdf .docx .md .txt</p>
            </>
          )}
        </div>
      ) : (
        <textarea
          className="input-field min-h-[120px] resize-none"
          placeholder="把文档内容粘贴到这里…"
          value={content}
          onChange={e => setContent(e.target.value)}
        />
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5 text-red-400 text-xs flex items-start gap-2">
          <X className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <button
        onClick={submit}
        disabled={uploading || !canSubmit}
        className="btn-primary w-full flex items-center justify-center gap-2"
      >
        {uploading && <Loader2 className="w-4 h-4 animate-spin" />}
        {uploading ? 'Indexing…' : 'Add to Knowledge Base'}
      </button>
    </div>
  )
}
