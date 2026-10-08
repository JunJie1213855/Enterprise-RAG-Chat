import axios from 'axios'
import type { RAGContext } from '@/types'

const BASE_URL = import.meta.env.VITE_API_URL || '/api/v1'

export interface StreamCallbacks {
  onSession?: (sessionId: string, title: string) => void
  onStatus?: (stage: string) => void
  onContext?: (contexts: RAGContext[]) => void
  onToken?: (token: string) => void
  onDone?: (sessionId: string) => void
  onError?: (message: string) => void
}

export interface StreamHandle {
  abort: () => void
}

interface StreamBody {
  message: string
  session_id?: string
  use_rag: boolean
}

/**
 * The browser EventSource API cannot be used here: it is GET-only, cannot send
 * an Authorization header, and has no abort support. So we POST with fetch and
 * parse the SSE frames off the response body ourselves.
 */
export function streamChat(body: StreamBody, cb: StreamCallbacks): StreamHandle {
  const controller = new AbortController()

  void (async () => {
    try {
      let res = await openStream(body, currentToken(), controller.signal)

      if (res.status === 401) {
        const refreshed = await refreshAccessToken()
        if (!refreshed) {
          cb.onError?.('Session expired. Please sign in again.')
          return
        }
        res = await openStream(body, refreshed, controller.signal)
      }

      if (!res.ok || !res.body) {
        cb.onError?.(await describeFailure(res))
        return
      }

      await readFrames(res.body, cb)
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        // User pressed stop — keep whatever was already rendered.
        return
      }
      cb.onError?.('Connection failed. Please try again.')
    }
  })()

  return { abort: () => controller.abort() }
}

function currentToken(): string {
  return localStorage.getItem('access_token') || ''
}

function openStream(body: StreamBody, token: string, signal: AbortSignal): Promise<Response> {
  return fetch(`${BASE_URL}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  })
}

async function refreshAccessToken(): Promise<string | null> {
  const refresh = localStorage.getItem('refresh_token')
  if (!refresh) return null

  try {
    const { data } = await axios.post(`${BASE_URL}/auth/refresh`, { refresh_token: refresh })
    localStorage.setItem('access_token', data.access_token)
    localStorage.setItem('refresh_token', data.refresh_token)
    return data.access_token as string
  } catch {
    localStorage.clear()
    return null
  }
}

async function describeFailure(res: Response): Promise<string> {
  try {
    const data = await res.json()
    if (typeof data?.detail === 'string') return data.detail
  } catch {
    // Non-JSON body (proxy error page) — fall through to the status mapping.
  }
  if (res.status === 413) return 'Message is too large.'
  if (res.status >= 502 && res.status <= 504) return 'Server is unavailable. Please try again.'
  return `Request failed (${res.status}).`
}

/**
 * Reads SSE frames. A network chunk may hold several frames, and one frame may
 * be split across chunks, so bytes are buffered and split on the frame
 * separator rather than parsed per chunk.
 */
async function readFrames(stream: ReadableStream<Uint8Array>, cb: StreamCallbacks): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')

      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        dispatchFrame(buffer.slice(0, sep), cb)
        buffer = buffer.slice(sep + 2)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function dispatchFrame(frame: string, cb: StreamCallbacks): void {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')

  // Keep-alive comments (": ping") carry no data line — nothing to dispatch.
  if (!data) return

  let event: { type: string; [k: string]: unknown }
  try {
    event = JSON.parse(data)
  } catch {
    return
  }

  switch (event.type) {
    case 'session':
      cb.onSession?.(event.session_id as string, event.title as string)
      break
    case 'status':
      cb.onStatus?.(event.stage as string)
      break
    case 'context':
      cb.onContext?.((event.contexts as RAGContext[]) || [])
      break
    case 'token':
      cb.onToken?.(event.content as string)
      break
    case 'done':
      cb.onDone?.(event.session_id as string)
      break
    case 'error':
      cb.onError?.((event.message as string) || 'Stream failed.')
      break
  }
}
