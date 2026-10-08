import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { chatApi } from '@/services/api'
import { useChatStore } from '@/store/chatStore'
import { useAuthStore } from '@/store/authStore'
import Sidebar from '@/components/Sidebar'
import MessageBubble from '@/components/MessageBubble'
import ChatInput from '@/components/ChatInput'
import RAGPanel from '@/components/RAGPanel'
import { Bot, Sparkles } from 'lucide-react'
import type { Message } from '@/types'

export default function ChatPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const {
    currentSessionId, setCurrentSession,
    messages, setMessages, addMessage,
    isLoading, setLoading,
    ragContexts, setRagContexts,
    useRag,
  } = useChatStore()

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [showRag, setShowRag] = useState(false)

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
  }, [messages, isLoading])

  const handleSend = async (text: string) => {
    if (!text.trim() || isLoading) return

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
    setLoading(true)

    try {
      const { data } = await chatApi.send({
        message: text,
        session_id: currentSessionId || undefined,
        use_rag: useRag,
      })

      // Update URL with session
      if (!currentSessionId || currentSessionId !== data.session_id) {
        setCurrentSession(data.session_id)
        navigate(`/chat/${data.session_id}`, { replace: true })
      }

      addMessage(data.message)
      setRagContexts(data.rag_context || [])

      if (data.rag_context?.length > 0) setShowRag(true)
    } catch (err: any) {
      const errMsg: Message = {
        id: crypto.randomUUID(),
        session_id: currentSessionId || '',
        role: 'assistant',
        content: err.response?.data?.detail || 'Something went wrong. Please try again.',
        tokens_used: 0,
        context_used: [],
        created_at: new Date().toISOString(),
      }
      addMessage(errMsg)
    } finally {
      setLoading(false)
    }
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
              <h1 className="text-sm font-semibold text-white">Enterprise Assistant</h1>
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

              {isLoading && <TypingIndicator />}
              <div ref={messagesEndRef} />
            </div>

            <div className="flex-shrink-0 px-4 pb-4">
              <ChatInput onSend={handleSend} disabled={isLoading} />
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
      <h2 className="text-xl font-semibold text-white mb-2">How can I help?</h2>
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

function TypingIndicator() {
  return (
    <div className="flex items-end gap-3 px-2 py-1 animate-fade-in">
      <div className="w-7 h-7 bg-brand-600/30 rounded-full flex items-center justify-center flex-shrink-0">
        <Bot className="w-3.5 h-3.5 text-brand-400" />
      </div>
      <div className="glass border border-white/5 rounded-2xl rounded-bl-sm px-4 py-3">
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="w-1.5 h-1.5 bg-brand-400 rounded-full animate-typing" style={{ animationDelay: `${i * 0.2}s` }} />
          ))}
        </div>
      </div>
    </div>
  )
}
