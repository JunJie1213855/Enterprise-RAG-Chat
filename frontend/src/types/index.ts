export interface User {
  id: string
  email: string
  username: string
  full_name?: string
  role: 'admin' | 'member' | 'viewer'
  organization_id?: string
  is_active: boolean
  is_verified: boolean
  created_at: string
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

export interface RAGContext {
  chunk_id: string
  document_title: string
  content: string
  similarity_score: number
}

export interface Message {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  tokens_used: number
  context_used: RAGContext[]
  created_at: string
}

export interface ChatSession {
  id: string
  title: string
  is_active: boolean
  message_count: number
  created_at: string
  updated_at: string
}

export interface SessionDetail {
  id: string
  title: string
  is_active: boolean
  messages: Message[]
  created_at: string
}

export interface ChatResponse {
  message: Message
  session_id: string
  session_title: string
  rag_context: RAGContext[]
  total_tokens: number
}

export interface ChatRequest {
  message: string
  session_id?: string
  use_rag?: boolean
  stream?: boolean
}

export interface Document {
  id: string
  title: string
  source?: string
  doc_type: string
  is_active: boolean
  created_at: string
  /** LightRAG ingest pipeline stage; null when the doc never reached the graph. */
  processing_status?: 'pending' | 'parsing' | 'analyzing' | 'processing' | 'processed' | 'failed' | null
}

export interface AdminStats {
  organization_id: string
  total_users: number
  total_sessions: number
  total_messages: number
  total_documents: number
}
