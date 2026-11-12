import { useState, type JSX } from 'react'
import { BookOpen } from 'lucide-react'
import { Button } from '../ui'
import { itemNoteProblem, refreshVaultStatus, useVaultStatus } from '../lib/vaultStatus'

interface OpenInObsidianProps {
  itemId: string
  taskId?: string
  disabled?: boolean
}

/**
 * "Open in Obsidian" for an item's (or task's) vault note, hidden while vault
 * notes can't be written. A note in conflict, deleted or waiting on iCloud
 * gets one warm line, with Recreate for a deleted note.
 */
export function OpenInObsidian({
  itemId,
  taskId,
  disabled = false
}: OpenInObsidianProps): JSX.Element | null {
  const status = useVaultStatus()
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!status?.writable) return null
  const problem = itemNoteProblem(status, itemId, taskId)

  const open = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const r = await window.api.openInObsidian(itemId, taskId)
      if ('error' in r) setMessage(r.error)
    } catch {
      setMessage("Obsidian didn't open. Is it installed?")
    } finally {
      setBusy(false)
    }
  }

  const recreate = async (): Promise<void> => {
    setBusy(true)
    const r = await window.api.recreateVaultNote(itemId, taskId).catch(() => null)
    setMessage(r?.ok ? null : (r?.error ?? "Couldn't recreate the note."))
    await refreshVaultStatus()
    setBusy(false)
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        leadingIcon={BookOpen}
        onClick={() => void open()}
        disabled={disabled || busy || problem?.state === 'deleted'}
        data-testid="open-in-obsidian"
      >
        Open in Obsidian
      </Button>
      {problem?.state === 'deleted' && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void recreate()}
          disabled={disabled || busy}
        >
          Recreate note
        </Button>
      )}
      {(message || problem?.message) && (
        <span role="status" className="text-[12.5px] text-fg-3" data-testid="vault-note-line">
          {message ?? problem?.message}
        </span>
      )}
    </span>
  )
}
