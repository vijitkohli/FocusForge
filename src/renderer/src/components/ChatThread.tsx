import React, { useEffect, useRef } from 'react'
import { ChatMessage } from 'src/common/types'

interface ChatThreadProps {
  messages: ChatMessage[]
  loading: boolean
  // Live tokens of the clarifying question currently being generated
  streamingText: string
}

/** Bottom-anchored intake conversation with the live-typing bubble. */
export function ChatThread({ messages, loading, streamingText }: ChatThreadProps): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading, streamingText])

  return (
    <div className="flex max-h-[40vh] flex-col gap-3 overflow-y-auto pr-1">
      {messages.length === 0 && (
        <div className="max-w-[75%] self-start rounded-2xl rounded-bl-sm bg-bg-2 px-4 py-3 text-sm">
          What do you need to get done? Tell me anything — big or small.
        </div>
      )}
      {messages.map((m, i) => (
        <div
          key={i}
          className={`max-w-[75%] cursor-text select-text rounded-2xl px-4 py-3 text-sm leading-relaxed ${
            m.role === 'user'
              ? 'self-end rounded-br-sm bg-accent text-white'
              : 'self-start rounded-bl-sm bg-bg-2 text-fg-1'
          }`}
        >
          {m.content}
        </div>
      ))}
      {loading && (
        <div
          className={`max-w-[75%] self-start rounded-2xl rounded-bl-sm bg-bg-2 px-4 py-3 text-sm ${
            streamingText ? 'leading-relaxed text-fg-1' : 'italic text-fg-2'
          }`}
        >
          {streamingText || 'Thinking…'}
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}
