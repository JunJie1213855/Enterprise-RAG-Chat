import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Plus, Bot, MessageSquare, Trash2, Settings,
  ChevronRight, LogOut, Users, LayoutDashboard,
  Database, ToggleLeft, ToggleRight, X, Menu,
  Upload, FileText, Loader2, Share2,
} from 'lucide-react'
import { chatApi, getApiError } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import { useChatStore } from '@/store/chatStore'
import { formatDistanceToNow } from 'date-fns'
import clsx from 'clsx'

export default function Sidebar() {
  const navigate = useNavigate()
  const { sessionId } = useParams()
  const { user, logout } = useAuthStore()
  const { sessions, setSessions, removeSession, useRag, setUseRag } = useChatStore()
  const [collapsed, setCollapsed] = useState(false)
  const [showDocs, setShowDocs] = useState(false)

  useEffect(() => {
    loadSessions()
  }, [])

  const loadSessions = async () => {
    try {
      const { data } = await chatApi.getSessions()
      setSessions(data.sessions || [])
    } catch {}
  }

  const newChat = () => {
    navigate('/chat')
  }

  const openSession = (id: string) => {
    navigate(`/chat/${id}`)
  }

  const deleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await chatApi.deleteSession(id)
    removeSession(id)
    if (sessionId === id) navigate('/chat')
  }

  const handleLogout = async () => {
    try { await chatApi.getSessions() } catch {}
    logout()
    navigate('/login')
  }

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-3 w-14 h-screen glass border-r border-white/5 py-4 flex-shrink-0">
        <button onClick={() => setCollapsed(false)} className="btn-ghost p-2">
          <Menu className="w-5 h-5" />
        </button>
        <button onClick={newChat} className="p-2 bg-brand-600 rounded-xl hover:bg-brand-500 transition-colors">
          <Plus className="w-5 h-5 text-white" />
        </button>
      </div>
    )
  }

  return (
    <aside className="w-64 flex-shrink-0 h-screen glass border-r border-white/5 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center">
            <Bot className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-white text-sm">EnterprisAI</span>
        </div>
        <button onClick={() => setCollapsed(true)} className="btn-ghost p-1.5">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* New Chat */}
      <div className="px-3 pt-3 pb-2">
        <button onClick={newChat} className="btn-primary w-full flex items-center gap-2 py-2.5 justify-center text-sm">
          <Plus className="w-4 h-4" />
          New Chat
        </button>
      </div>

      {/* RAG toggle */}
      <div className="px-3 pb-2">
        <button
          onClick={() => setUseRag(!useRag)}
          className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-surface-100 hover:bg-surface-200 transition-colors text-sm"
        >
          <span className="text-gray-400 flex items-center gap-2">
            <Database className="w-3.5 h-3.5" />
            Knowledge Base
          </span>
          {useRag
            ? <ToggleRight className="w-5 h-5 text-brand-400" />
            : <ToggleLeft className="w-5 h-5 text-gray-500" />
          }
        </button>
      </div>

      {/* Sessions */}
      <div className="flex-1 overflow-y-auto px-3 pb-2">
        <p className="text-xs text-gray-600 uppercase tracking-wider px-1 mb-2 mt-1">Recents</p>
        {sessions.length === 0 ? (
          <p className="text-xs text-gray-600 px-1 py-2">No conversations yet</p>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => openSession(s.id)}
              className={clsx('sidebar-item group', sessionId === s.id && 'active')}
            >
              <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
              <div className="flex-1 min-w-0">
                <p className="truncate text-xs font-medium">{s.title}</p>
                <p className="text-xs text-gray-600 truncate">
                  {formatDistanceToNow(new Date(s.updated_at), { addSuffix: true })}
                </p>
              </div>
              <button
                onClick={(e) => deleteSession(e, s.id)}
                className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 transition-all"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-white/5 px-3 py-3 space-y-1">
        {user?.role === 'admin' && (
          <button onClick={() => navigate('/admin')} className="sidebar-item w-full">
            <LayoutDashboard className="w-4 h-4" />
            <span>Admin Panel</span>
          </button>
        )}
        <button onClick={() => setShowDocs(true)} className="sidebar-item w-full">
          <Database className="w-4 h-4" />
          <span>Knowledge Base</span>
        </button>
        <button onClick={() => navigate('/graph')} className="sidebar-item w-full">
          <Share2 className="w-4 h-4" />
          <span>Knowledge Graph</span>
        </button>
        <button onClick={handleLogout} className="sidebar-item w-full text-red-500 hover:text-red-400">
          <LogOut className="w-4 h-4" />
          <span>Sign out</span>
        </button>
        <div className="flex items-center gap-2 px-1 pt-2 mt-1 border-t border-white/5">
          <div className="w-7 h-7 bg-brand-600/30 rounded-full flex items-center justify-center text-xs font-bold text-brand-300">
            {user?.username?.[0]?.toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-gray-300 truncate">{user?.full_name || user?.username}</p>
            <p className="text-xs text-gray-600 truncate">{user?.role}</p>
          </div>
        </div>
      </div>

      {showDocs && <DocsModal onClose={() => setShowDocs(false)} />}
    </aside>
  )
}

const ACCEPTED_FILE_TYPES = '.pdf,.docx,.md,.markdown,.txt'

function DocsModal({ onClose }: { onClose: () => void }) {
  const [docs, setDocs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'file' | 'paste'>('file')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    chatApi.getDocuments()
      .then(r => { setDocs(r.data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const reset = () => {
    setTitle(''); setContent(''); setFile(null); setError('')
    if (fileInput.current) fileInput.current.value = ''
  }

  const pickFile = (picked: File | null | undefined) => {
    if (!picked) return
    setError('')
    setFile(picked)
  }

  const uploadFile = async () => {
    if (!file) return
    setUploading(true); setError('')
    try {
      const { data } = await chatApi.uploadDocumentFile(file, title.trim() || undefined)
      setDocs([...docs, data])
      reset()
    } catch (e: unknown) {
      setError(getApiError(e, 'Upload failed. Please try again.'))
    }
    setUploading(false)
  }

  const uploadText = async () => {
    if (!title.trim() || !content.trim()) return
    setUploading(true); setError('')
    try {
      const { data } = await chatApi.uploadDocument({ title, content, doc_type: 'text' })
      setDocs([...docs, data])
      reset()
    } catch (e: unknown) {
      setError(getApiError(e, 'Upload failed. Please try again.'))
    }
    setUploading(false)
  }

  const remove = async (id: string) => {
    await chatApi.deleteDocument(id)
    setDocs(docs.filter(d => d.id !== id))
  }

  const tabClass = (active: boolean) =>
    clsx(
      'flex-1 py-2 rounded-lg text-sm font-medium transition-all',
      active ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-white/5',
    )

  // Portal to <body>: the sidebar uses backdrop-blur, which makes it the
  // containing block for `position: fixed` children — without the portal the
  // modal gets trapped inside the 256px-wide aside.
  return createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="glass-card w-full max-w-lg max-h-[80vh] flex flex-col animate-slide-up">
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <h3 className="font-semibold text-white flex items-center gap-2">
            <Database className="w-4 h-4 text-brand-400" />
            Knowledge Base
          </h3>
          <button onClick={onClose} className="btn-ghost p-1.5"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="space-y-3">
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
                onDrop={e => {
                  e.preventDefault(); setDragging(false)
                  pickFile(e.dataTransfer.files?.[0])
                }}
                onClick={() => fileInput.current?.click()}
                className={clsx(
                  'flex flex-col items-center justify-center gap-2 py-6 rounded-xl border border-dashed cursor-pointer transition-all',
                  dragging ? 'border-brand-500/60 bg-brand-600/10' : 'border-white/10 hover:border-white/20',
                )}
              >
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  accept={ACCEPTED_FILE_TYPES}
                  onChange={e => pickFile(e.target.files?.[0])}
                />
                {file ? (
                  <>
                    <FileText className="w-5 h-5 text-brand-400" />
                    <p className="text-sm text-gray-200 truncate max-w-full px-4">{file.name}</p>
                    <p className="text-xs text-gray-500">{(file.size / 1024).toFixed(0)} KB — click to change</p>
                  </>
                ) : (
                  <>
                    <Upload className="w-5 h-5 text-gray-500" />
                    <p className="text-sm text-gray-400">Drop a file here, or click to browse</p>
                    <p className="text-xs text-gray-600">Supports .pdf .docx .md .txt</p>
                  </>
                )}
              </div>
            ) : (
              <textarea
                className="input-field min-h-[80px] resize-none"
                placeholder="Paste document content here..."
                value={content}
                onChange={e => setContent(e.target.value)}
              />
            )}

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5 text-red-400 text-xs">
                {error}
              </div>
            )}

            <button
              onClick={mode === 'file' ? uploadFile : uploadText}
              disabled={uploading || (mode === 'file' ? !file : !title.trim() || !content.trim())}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {uploading ? 'Indexing...' : 'Add to Knowledge Base'}
            </button>
          </div>

          <div className="space-y-2">
            {loading ? <p className="text-sm text-gray-500 text-center">Loading...</p> : null}
            {docs.map(d => (
              <div key={d.id} className="flex items-center gap-3 p-3 bg-surface-100 rounded-xl border border-white/5">
                <Database className="w-4 h-4 text-brand-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-200 truncate">{d.title}</p>
                  <p className="text-xs text-gray-500">{d.doc_type}</p>
                </div>
                <button onClick={() => remove(d.id)} className="text-gray-600 hover:text-red-400 transition-colors p-1">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
