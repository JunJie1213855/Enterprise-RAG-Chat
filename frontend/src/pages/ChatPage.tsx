import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { chatApi } from '@/services/api'
import { streamChat, type StreamHandle } from '@/services/stream'
import { useChatStore } from '@/store/chatStore'
import { useAuthStore } from '@/store/authStore'
import Sidebar from '@/components/Sidebar'
import MessageBubble from '@/components/MessageBubble'
import ChatInput from '@/components/ChatInput'
import RAGPanel from '@/components/RAGPanel'
import { Bot, Sparkles } from 'lucide-react'
import type { Message } from '@/types'

const STATUS_LABELS: Record<string, string> = {
  retrieving: 'Searching your knowledge base…',
  generating: 'Thinking…',
}

export default function ChatPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const {
    currentSessionId, setCurrentSession, setSessionId,
    sessions, addSession, updateSessionTitle,
    messages, setMessages, addMessage,
    isStreaming, setStreaming, streamBuffer, appendStream, clearStream,
    ragContexts, setRagContexts,
    useRag,
  } = useChatStore()

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [showRag, setShowRag] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const streamRef = useRef<StreamHandle | null>(null)

  // Load session from URL
  useEffect(() => {
    if (sessionId && sessionId !== currentSessionId) {
      loadSession(sessionId)
    } else if (!sessionId) {
      setCurrentSession(null)
      setMessages([])
    }
  }, [sessionId])

  const loadSession = async (id: string) => {
    try {
      const { data } = await chatApi.getSession(id)
      setCurrentSession(id)
      setMessages(data.messages || [])
    } catch {
      navigate('/chat')
    }
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isStreaming, streamBuffer])

  const finalizeStream = (errorText?: string) => {
    const assistantText = useChatStore.getState().streamBuffer.trim()
    const sid = useChatStore.getState().currentSessionId || ''

    if (assistantText) {
      // Keep whatever arrived — a stopped generation is still worth showing.
      addMessage({
        id: crypto.randomUUID(),
        session_id: sid,
        role: 'assistant',
        content: assistantText,
        tokens_used: 0,
        context_used: [],
        created_at: new Date().toISOString(),
      })
    } else if (errorText) {
      addMessage({
        id: crypto.randomUUID(),
        session_id: sid,
        role: 'assistant',
        content: errorText,
        tokens_used: 0,
        context_used: [],
        created_at: new Date().toISOString(),
      })
    }

    clearStream()
    setStreaming(false)
    setStatus(null)
    streamRef.current = null
  }

  const handleSend = (text: string) => {
    if (!text.trim() || isStreaming) return

    const userMsg: Message = {
      id: crypto.randomUUID(),
      session_id: currentSessionId || '',
      role: 'user',
      content: text,
      tokens_used: 0,
      context_used: [],
      created_at: new Date().toISOString(),
    }
    addMessage(userMsg)
    clearStream()
    setStreaming(true)
    setStatus(null)

    const requestedSessionId = currentSessionId || undefined

    streamRef.current = streamChat(
      { message: text, session_id: requestedSessionId, use_rag: useRag },
      {
        onSession: (id, title) => {
          if (!requestedSessionId) {
            // New session: point at it (without wiping the message list) and
            // surface it in the sidebar right away.
            setSessionId(id)
            navigate(`/chat/${id}`, { replace: true })
            if (!useChatStore.getState().sessions.some((s) => s.id === id)) {
              addSession({
                id,
                title,
                is_active: true,
                message_count: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
            }
          } else {
            updateSessionTitle(id, title)
          }
        },
        onStatus: (stage) => setStatus(STATUS_LABELS[stage] || null),
        onContext: (contexts) => {
          setRagContexts(contexts)
          if (contexts.length > 0) setShowRag(true)
        },
        onToken: appendStream,
        onDone: () => finalizeStream(),
        onError: (msg) => finalizeStream(msg),
      },
    )
  }

  const handleStop = () => {
    streamRef.current?.abort()
    streamRef.current = null
    // The backend persists what it already generated; mirror that locally.
    finalizeStream()
  }

  // Abort an in-flight stream when leaving the page.
  useEffect(() => () => streamRef.current?.abort(), [])

  // Rendered as a normal bubble so markdown/code render exactly like a
  // finished message — the only difference is the caret.
  const streamingStartedAt = useRef(new Date().toISOString())
  const streamingMessage: Message = {
    id: 'streaming',
    session_id: currentSessionId || '',
    role: 'assistant',
    content: streamBuffer,
    tokens_used: 0,
    context_used: [],
    created_at: streamingStartedAt.current,
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />

      <main className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="glass border-b border-white/5 px-6 py-3 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-brand-600/30 rounded-lg flex items-center justify-center">
              <Bot className="w-4 h-4 text-brand-400" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-strong">Enterprise Assistant</h1>
              <p className="text-xs text-gray-500">RAG-powered · {user?.organization_id ? 'Org knowledge active' : 'Personal'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {ragContexts.length > 0 && (
              <button
                onClick={() => setShowRag(!showRag)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-brand-600/20 text-brand-300 border border-brand-500/20 hover:bg-brand-600/30 transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {ragContexts.length} sources
              </button>
            )}
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {/* Messages */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto px-4 py-6 space-y-1">
              {messages.length === 0 ? (
                <EmptyState />
              ) : (
                messages.map((msg) => (
                  <MessageBubble key={msg.id} message={msg} />
                ))
              )}

              {isStreaming && (
                streamBuffer
                  ? <MessageBubble message={streamingMessage} streaming />
                  : <TypingIndicator label={status} />
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="flex-shrink-0 px-4 pb-4">
              <ChatInput
                onSend={handleSend}
                onStop={handleStop}
                streaming={isStreaming}
              />
            </div>
          </div>

          {/* RAG Panel */}
          {showRag && ragContexts.length > 0 && (
            <RAGPanel contexts={ragContexts} onClose={() => setShowRag(false)} />
          )}
        </div>
      </main>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full py-20 animate-fade-in">
      <div className="w-16 h-16 bg-brand-600/20 rounded-2xl flex items-center justify-center mb-4 border border-brand-500/20">
        <Bot className="w-8 h-8 text-brand-400" />
      </div>
      <h2 className="text-xl font-semibold text-strong mb-2">How can I help?</h2>
      <p className="text-gray-500 text-sm text-center max-w-xs">
        Ask me anything. I'll search through your organization's knowledge base to give you accurate answers.
      </p>
      <div className="mt-8 grid grid-cols-1 gap-2 w-full max-w-sm">
        {[
          'What products do you offer?',
          'What is the support policy?',
          'Tell me about the company',
        ].map((q) => (
          <div key={q} className="glass border border-white/5 rounded-xl px-4 py-3 text-sm text-gray-400 cursor-pointer hover:text-gray-200 hover:border-brand-500/20 transition-all">
            {q}
          </div>
        ))}
      </div>
    </div>
  )
}

function TypingIndicator({ label }: { label?: string | null }) {
  return (
    <div className="flex items-end gap-3 px-2 py-1 animate-fade-in">
      <div className="w-7 h-7 bg-brand-600/30 rounded-full flex items-center justify-center flex-shrink-0">
        <Bot className="w-3.5 h-3.5 text-brand-400" />
      </div>
      <div className="glass border border-white/5 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-3">
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="w-1.5 h-1.5 bg-brand-400 rounded-full animate-typing" style={{ animationDelay: `${i * 0.2}s` }} />
          ))}
        </div>
        {label && <span className="text-xs text-gray-500">{label}</span>}
      </div>
    </div>
  )
}
