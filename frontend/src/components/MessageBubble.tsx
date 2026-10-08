import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Bot, User, Copy, Check } from 'lucide-react'
import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import clsx from 'clsx'
import type { Message } from '@/types'

interface Props {
  message: Message
  /** Render the in-flight assistant reply (adds a caret). */
  streaming?: boolean
}

export default function MessageBubble({ message, streaming }: Props) {
  const isUser = message.role === 'user'
  const [copied, setCopied] = useState(false)

  const copyContent = () => {
    navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={clsx(
      'flex gap-3 px-2 py-1 group animate-fade-in',
      isUser ? 'flex-row-reverse' : 'flex-row'
    )}>
      {/* Avatar */}
      <div className={clsx(
        'w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-1',
        isUser
          ? 'bg-brand-600/40 border border-brand-500/30'
          : 'bg-surface-200 border border-white/10'
      )}>
        {isUser
          ? <User className="w-3.5 h-3.5 text-brand-300" />
          : <Bot className="w-3.5 h-3.5 text-gray-400" />
        }
      </div>

      {/* Bubble */}
      <div className={clsx(
        'max-w-[78%] rounded-2xl px-4 py-3 relative',
        isUser
          ? 'bg-brand-600/25 border border-brand-500/20 rounded-tr-sm'
          : 'glass border border-white/5 rounded-tl-sm'
      )}>
        {isUser ? (
          <p className="text-gray-200 text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose-chat text-sm">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ node, className, children, ...props }: any) {
                  const match = /language-(\w+)/.exec(className || '')
                  return match ? (
                    <SyntaxHighlighter
                      style={oneDark as any}
                      language={match[1]}
                      PreTag="div"
                      customStyle={{ borderRadius: '0.75rem', margin: '0.5rem 0', fontSize: '0.8rem' }}
                    >
                      {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                  ) : (
                    <code className={className} {...props}>{children}</code>
                  )
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
            {streaming && (
              <span className="inline-block w-1.5 h-4 ml-0.5 align-text-bottom bg-brand-400 animate-pulse" />
            )}
          </div>
        )}

        {/* Meta */}
        <div className={clsx(
          'flex items-center gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity',
          isUser ? 'justify-start flex-row-reverse' : 'justify-start'
        )}>
          <span className="text-xs text-gray-600">
            {formatDistanceToNow(new Date(message.created_at), { addSuffix: true })}
          </span>
          {message.tokens_used > 0 && (
            <span className="text-xs text-gray-700">{message.tokens_used} tokens</span>
          )}
          <button onClick={copyContent} className="text-gray-600 hover:text-gray-300 transition-colors">
            {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>
      </div>
    </div>
  )
}
