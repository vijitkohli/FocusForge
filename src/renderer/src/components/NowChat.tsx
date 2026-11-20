import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { ArrowUp, CornerDownRight } from 'lucide-react'
import type { NowChatMessage, NowChatPick } from '../../../common/nowChat'
import { localDateKey } from '../../../common/schedule'
import { queueStore } from '../lib/queue'
import { Button, IconButton } from '../ui'

const STORAGE_KEY = 'focusforge.nowchat'
const STARTERS = ['Just back from a break', 'Low on energy', 'Something different', 'Pick for me']

/** The chat lasts for the day (per viewer); a new day starts fresh. */
function loadToday(): NowChatMessage[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (raw?.date === localDateKey(new Date()) && Array.isArray(raw.messages)) return raw.messages
  } catch {
    // Unreadable or unavailable storage: start empty.
  }
  return []
}

function saveToday(messages: NowChatMessage[]): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ date: localDateKey(new Date()), messages: messages.slice(-40) })
    )
  } catch {
    // The chat still works for this session.
  }
}

/** Put the picked step in the "What next?" card (no second player). */
function showInCard(pick: NowChatPick): void {
  queueStore.setMood('all')
  queueStore.playNext({ projectId: pick.projectId, taskId: pick.taskId, subtaskId: pick.subtaskId })
}

/**
 * Now screen chat: say how you're doing, get one step to start. A suggestion
 * replaces the step in the "What next?" card above.
 */
export function NowChat(): JSX.Element {
  const [messages, setMessages] = useState<NowChatMessage[]>(loadToday)
  const [replies, setReplies] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const log = useRef<HTMLDivElement>(null)

  useEffect(() => saveToday(messages), [messages])
  useEffect(() => {
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, busy])

  async function send(text: string, history = messages): Promise<void> {
    const content = text.trim()
    if (!content || busy) return
    const next: NowChatMessage[] = [...history, { role: 'user', content }]
    setMessages(next)
    setDraft('')
    setReplies([])
    setError('')
    setBusy(true)
    try {
      const reply = await window.api.nowChat(next.map(({ role, content }) => ({ role, content })))
      if (reply.cancelled) return
      if (!reply.ok) {
        setError(reply.message)
        return
      }
      if (reply.pick) showInCard(reply.pick)
      setMessages([...next, { role: 'assistant', content: reply.message, pick: reply.pick }])
      setReplies(reply.replies)
    } catch {
      setError("Couldn't reach the coach. Check that CLIProxyAPI is running.")
    } finally {
      setBusy(false)
    }
  }

  function retry(): void {
    const last = messages[messages.length - 1]
    if (last?.role !== 'user') return
    void send(last.content, messages.slice(0, -1))
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send(draft)
    }
  }

  const chips = messages.length === 0 ? STARTERS : replies

  return (
    <section
      aria-labelledby="now-chat-heading"
      className="flex min-w-0 flex-col rounded-md bg-bg-2 p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="now-chat-heading" className="section-title">
          Not sure what to do?
        </h2>
        {messages.length > 0 && !busy && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMessages([])
              setReplies([])
              setError('')
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {(messages.length > 0 || busy) && (
        <div
          ref={log}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          className="mt-4 flex max-h-[360px] flex-col gap-4 overflow-y-auto pr-1"
        >
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <p key={i} className="max-w-[80%] self-end rounded-md bg-bg-3 px-3.5 py-2 text-fg-1">
                {m.content}
              </p>
            ) : (
              <div key={i} className="max-w-[72ch]">
                <p className="text-fg-1">{m.content}</p>
                {m.pick && (
                  <button
                    type="button"
                    onClick={() => m.pick && showInCard(m.pick)}
                    className="mt-1.5 inline-flex items-start gap-1.5 rounded-xs text-left text-sm text-fg-3 hover:text-fg-1"
                    title="Show this step in What next"
                  >
                    <CornerDownRight size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
                    <span>
                      {m.pick.itemName} · {m.pick.title}
                    </span>
                  </button>
                )}
              </div>
            )
          )}
          {busy && <p className="text-sm text-fg-3">Thinking…</p>}
        </div>
      )}

      {error && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-fg-2">
            {error}
          </p>
          <Button size="sm" variant="secondary" onClick={retry}>
            Try again
          </Button>
        </div>
      )}

      {chips.length > 0 && !busy && (
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Quick replies" role="group">
          {chips.map((chip) => (
            <Button key={chip} size="sm" variant="secondary" onClick={() => void send(chip)}>
              {chip}
            </Button>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-end gap-2">
        <label htmlFor="now-chat-input" className="sr-only">
          Message the coach
        </label>
        <textarea
          id="now-chat-input"
          rows={1}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="How are you feeling right now?"
          className="field-sizing-content max-h-32 min-h-11 flex-1 resize-none rounded-md border border-line bg-bg-1 px-3.5 py-2.5 text-fg-1 placeholder:text-fg-3 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
        />
        <IconButton
          label="Send"
          icon={ArrowUp}
          size={36}
          variant="secondary"
          disabled={busy || !draft.trim()}
          onClick={() => void send(draft)}
        />
      </div>
    </section>
  )
}
