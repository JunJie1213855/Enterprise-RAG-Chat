import { create } from 'zustand'
import type { ChatSession, Message, RAGContext } from '@/types'

interface ChatState {
  sessions: ChatSession[]
  currentSessionId: string | null
  messages: Message[]
  isLoading: boolean
  isStreaming: boolean
  streamBuffer: string
  ragContexts: RAGContext[]
  useRag: boolean

  setSessions: (sessions: ChatSession[]) => void
  addSession: (session: ChatSession) => void
  removeSession: (id: string) => void
  setCurrentSession: (id: string | null) => void
  setMessages: (messages: Message[]) => void
  addMessage: (message: Message) => void
  setLoading: (v: boolean) => void
  setStreaming: (v: boolean) => void
  appendStream: (chunk: string) => void
  clearStream: () => void
  setRagContexts: (contexts: RAGContext[]) => void
  setUseRag: (v: boolean) => void
  updateSessionTitle: (id: string, title: string) => void
}

export const useChatStore = create<ChatState>((set) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  isLoading: false,
  isStreaming: false,
  streamBuffer: '',
  ragContexts: [],
  useRag: true,

  setSessions: (sessions) => set({ sessions }),
  addSession: (session) =>
    set((s) => ({ sessions: [session, ...s.sessions] })),
  removeSession: (id) =>
    set((s) => ({ sessions: s.sessions.filter((s) => s.id !== id) })),
  setCurrentSession: (id) =>
    set({ currentSessionId: id, messages: [], ragContexts: [] }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) =>
    set((s) => ({ messages: [...s.messages, message] })),
  setLoading: (isLoading) => set({ isLoading }),
  setStreaming: (isStreaming) => set({ isStreaming }),
  appendStream: (chunk) =>
    set((s) => ({ streamBuffer: s.streamBuffer + chunk })),
  clearStream: () => set({ streamBuffer: '' }),
  setRagContexts: (ragContexts) => set({ ragContexts }),
  setUseRag: (useRag) => set({ useRag }),
  updateSessionTitle: (id, title) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, title } : sess
      ),
    })),
}))
