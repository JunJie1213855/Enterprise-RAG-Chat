import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Plus, Bot, MessageSquare, Trash2, Settings,
  ChevronRight, LogOut, Users, LayoutDashboard,
  Database, ToggleLeft, ToggleRight, X, Menu,
  Upload, FileText, Loader2, RotateCcw,
} from 'lucide-react'
import { chatApi, getApiError } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import { useChatStore } from '@/store/chatStore'
import ThemeToggle from '@/components/ThemeToggle'
import { formatDistanceToNow } from 'date-fns'
import clsx from 'clsx'

export default function Sidebar() {
  const navigate = useNavigate()
  const { sessionId } = useParams()
  const { user, logout } = useAuthStore()
  const { sessions, setSessions, removeSession, useRag, setUseRag } = useChatStore()
  const [collapsed, setCollapsed] = useState(false)

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
          <span className="font-bold text-strong text-sm">EnterprisAI</span>
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
            RAG 检索
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
        <button onClick={() => navigate('/knowledge')} className="sidebar-item w-full">
          <Database className="w-4 h-4" />
          <span>Knowledge Dataset</span>
        </button>
        <ThemeToggle />
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

    </aside>
  )
}
