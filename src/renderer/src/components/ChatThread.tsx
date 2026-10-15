import { useEffect, useRef, type JSX } from 'react'
import type { ChatMessage } from 'src/common/types'
import { Button } from '../ui'

export interface ChatThreadProps {
  messages: ChatMessage[]
  loading: boolean
  streamingText: string
  onExampleSelect?: (text: string) => void
  className?: string
}

const EXAMPLES = [
  'Lab report due Friday',
  'Revise for my COMP exam',
  "Reply to an email I've been ignoring"
]

export function ChatThread({
  messages,
  loading,
  streamingText,
  onExampleSelect,
  className = ''
}: ChatThreadProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)

  useEffect(() => {
    const element = scrollRef.current
    if (element && followRef.current) element.scrollTop = element.scrollHeight
  }, [messages, loading, streamingText])

  return (
    <div
      ref={scrollRef}
      className={`flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-6 ${className}`}
      onScroll={(event) => {
        const element = event.currentTarget
        followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
      }}
      role="log"
      aria-label="Conversation with the coach"
      aria-live="polite"
      aria-relevant="additions"
    >
      {messages.length === 0 && (
        <div className="space-y-4">
          <p className="max-w-[85%] rounded-md bg-bg-2 px-4 py-3 text-sm leading-[1.55] text-fg-1">
            What are you avoiding? Tell me anything, big or small.
          </p>
          {onExampleSelect && (
            <div className="flex flex-wrap gap-2" aria-label="Conversation starters">
              {EXAMPLES.map((text) => (
                <Button
                  key={text}
                  size="sm"
                  variant="secondary"
                  onClick={() => onExampleSelect(text)}
                >
                  {text}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
      {messages.map((message, index) => (
        <div
          key={index}
          aria-label={message.role === 'user' ? 'You' : 'Coach'}
          className={`max-w-[85%] cursor-text select-text rounded-md px-4 py-3 text-sm leading-[1.55] whitespace-pre-wrap break-words text-fg-1 ${
            message.role === 'user' ? 'self-end bg-accent-soft' : 'self-start bg-bg-2'
          }`}
        >
          {message.content}
        </div>
      ))}
      {loading && (
        <div className="max-w-[85%] self-start rounded-md bg-bg-2 px-4 py-3 text-sm leading-[1.55] whitespace-pre-wrap break-words text-fg-1">
          {streamingText || (
            <span role="status" className="flex h-5 items-center gap-1.5">
              <span className="sr-only">Coach is responding</span>
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-fg-2 motion-safe:animate-pulse"
                  style={{ animationDelay: `${dot * 160}ms` }}
                />
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
