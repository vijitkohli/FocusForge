import { useState, type JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import { syncLabel, useNow, useReaderStatuses } from '../lib/readerStatus'
import { Button } from '../ui'

export interface SyncStatusProps {
  itemId: string
  /** Compact: text only (Library rows). Full: text plus a Refresh button. */
  compact?: boolean
}

/** "Synced 3 min ago" / "Summarising…" / a friendly error, plus Refresh. */
export function SyncStatus({ itemId, compact = false }: SyncStatusProps): JSX.Element | null {
  const statuses = useReaderStatuses()
  const now = useNow()
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const status = statuses[itemId]
  if (!status || status.state === 'no-sources') return null
  const { text, tone } = syncLabel(status, now)
  const color = tone === 'warn' ? 'text-hard' : 'text-fg-3'

  if (compact) {
    return text ? <p className={`mt-1 truncate text-[12px] ${color}`}>{text}</p> : null
  }

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const r = await window.api.refreshItem(itemId)
      if (!r.queued) {
        setNote(
          r.reason === 'disabled'
            ? 'Syncing is turned off.'
            : r.reason === 'no-sources'
              ? 'This item has no sources yet.'
              : 'Everything is already up to date.'
        )
      }
    } catch {
      setNote("Couldn't start a refresh. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-[12.5px]" aria-live="polite">
      <span className={color}>{text}</span>
      <Button
        size="sm"
        variant="ghost"
        leadingIcon={RefreshCw}
        loading={busy}
        loadingLabel="Refreshing"
        disabled={status.state === 'digesting' || status.state === 'reading'}
        onClick={() => void refresh()}
      >
        Refresh
      </Button>
      {note && <span className="text-fg-3">{note}</span>}
    </div>
  )
}
