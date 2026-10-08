import { useState, useRef, useEffect } from 'react'
import { Send, Square } from 'lucide-react'
import clsx from 'clsx'

interface Props {
  onSend: (text: string) => void
  onStop?: () => void
  streaming?: boolean
  disabled?: boolean
}

export default function ChatInput({ onSend, onStop, streaming, disabled }: Props) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const blocked = disabled || streaming

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [value])

  const handleSend = () => {
    const trimmed = value.trim()
    if (!trimmed || blocked) return
    onSend(trimmed)
    setValue('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="glass border border-white/8 rounded-2xl overflow-hidden focus-within:border-brand-500/40 transition-all">
      <div className="flex items-end gap-2 p-3">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKey}
          placeholder={streaming ? 'Generating… press stop to interrupt' : 'Ask anything... (Shift+Enter for new line)'}
          rows={1}
          disabled={blocked}
          className={clsx(
            'flex-1 bg-transparent text-gray-100 placeholder-gray-600 text-sm',
            'resize-none focus:outline-none leading-relaxed py-1',
            'min-h-[24px] max-h-[200px] overflow-y-auto',
            blocked && 'opacity-50 cursor-not-allowed'
          )}
        />
        {streaming ? (
          <button
            onClick={onStop}
            title="Stop generating"
            className="flex-shrink-0 p-2.5 rounded-xl bg-surface-200 hover:bg-surface-300 text-gray-300 transition-all duration-150 active:scale-95"
          >
            <Square className="w-4 h-4 fill-current" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={blocked || !value.trim()}
            className={clsx(
              'flex-shrink-0 p-2.5 rounded-xl transition-all duration-150',
              value.trim() && !blocked
                ? 'bg-brand-600 hover:bg-brand-500 text-white shadow-lg shadow-brand-900/30 active:scale-95'
                : 'bg-surface-200 text-gray-600 cursor-not-allowed'
            )}
          >
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>
      <div className="px-4 pb-2 flex items-center gap-3">
        <span className="text-xs text-gray-700">Enter to send · Shift+Enter for newline</span>
        {value.length > 0 && (
          <span className={clsx('text-xs ml-auto', value.length > 9000 ? 'text-red-400' : 'text-gray-700')}>
            {value.length}/10000
          </span>
        )}
      </div>
    </div>
  )
}
