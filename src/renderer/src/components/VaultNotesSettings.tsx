import { useEffect, useId, useState, type JSX } from 'react'
import { ClipboardCopy, RefreshCw } from 'lucide-react'
import { Button, Checkbox } from '../ui'
import { refreshVaultStatus, useVaultStatus, vaultProblems, vaultSummary } from '../lib/vaultStatus'

interface VaultNotesSettingsProps {
  disabled?: boolean
}

/**
 * Phase 4 vault notes: the on/off toggle, a one-line status, notes that need
 * a look, Sync now and Copy Dataview snippet. Shown inside Sources.
 */
export function VaultNotesSettings({ disabled = false }: VaultNotesSettingsProps): JSX.Element {
  const status = useVaultStatus()
  const id = useId()
  const [syncing, setSyncing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const toggle = async (on: boolean): Promise<void> => {
    setSaving(true)
    setMessage(null)
    try {
      await window.api.saveSettings({ vaultNotes: on })
      await refreshVaultStatus()
    } catch {
      setMessage({ tone: 'warn', text: "That didn't save. Try again." })
    } finally {
      setSaving(false)
    }
  }

  const syncNow = async (): Promise<void> => {
    setSyncing(true)
    setMessage(null)
    try {
      await window.api.syncVaultNow()
      await refreshVaultStatus()
      setNowMs(Date.now())
    } catch {
      setMessage({ tone: 'warn', text: "Couldn't sync just now. Try again in a moment." })
    } finally {
      setSyncing(false)
    }
  }

  const copySnippet = async (): Promise<void> => {
    setMessage(null)
    try {
      const snippet = await window.api.getDataviewSnippet()
      await navigator.clipboard.writeText(snippet)
      setMessage({ tone: 'ok', text: 'Copied. Paste it into your Dashboard note.' })
    } catch {
      setMessage({ tone: 'warn', text: "Couldn't copy it. It's also in “About these notes”." })
    }
  }

  const recreate = async (itemId: string, taskId?: string): Promise<void> => {
    const r = await window.api.recreateVaultNote(itemId, taskId).catch(() => null)
    setMessage(
      r?.ok
        ? { tone: 'ok', text: 'Note recreated.' }
        : { tone: 'warn', text: r?.error ?? "Couldn't recreate the note." }
    )
    await refreshVaultStatus()
  }

  const resumeFolder = async (): Promise<void> => {
    await window.api.resumeVaultFolder().catch(() => undefined)
    await refreshVaultStatus()
  }

  const problems = vaultProblems(status)
  const busy = disabled || saving

  return (
    <div className="space-y-3 rounded-md bg-bg-2 p-4" aria-labelledby={`${id}-title`} role="group">
      <h3 id={`${id}-title`} className="text-base font-bold text-fg-1">
        Vault notes
      </h3>
      <div className="space-y-1.5">
        <Checkbox
          label="Keep a note for each item in Obsidian"
          checked={status?.enabled ?? false}
          disabled={busy || !status}
          onChange={(event) => void toggle(event.target.checked)}
          aria-describedby={`${id}-desc`}
        />
        <p id={`${id}-desc`} className="max-w-[72ch] text-[12.5px] leading-[1.55] text-fg-3">
          FocusForge writes only inside a FocusForge folder in your vault. Tick a step there and
          it&apos;s done here too. What you write under My notes is yours and is never changed.
        </p>
      </div>
      {status && (
        <p role="status" className="text-sm text-fg-2" data-testid="vault-summary">
          {vaultSummary(status, nowMs)}
        </p>
      )}
      {status?.reason === 'folder-removed' && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void resumeFolder()}>
            Recreate the folder
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void toggle(false)}>
            Turn off
          </Button>
        </div>
      )}
      {problems.length > 0 && (
        <ul aria-label="Notes that need a look" className="space-y-1.5 text-sm">
          {problems.map((n) => (
            <li key={`${n.itemId}/${n.taskId ?? ''}`} className="flex flex-wrap items-center gap-2">
              <span className="text-fg-1">{n.title}:</span>
              <span className="text-fg-2">{n.message}</span>
              {n.state === 'deleted' && (
                <Button size="sm" variant="ghost" onClick={() => void recreate(n.itemId, n.taskId)}>
                  Recreate
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p
          role={message.tone === 'warn' ? 'alert' : 'status'}
          className={`text-sm ${message.tone === 'warn' ? 'text-medium' : 'text-easy'}`}
        >
          {message.text}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          leadingIcon={RefreshCw}
          loading={syncing}
          loadingLabel="Syncing"
          disabled={busy || !status?.writable}
          onClick={() => void syncNow()}
        >
          Sync now
        </Button>
        <Button leadingIcon={ClipboardCopy} disabled={disabled} onClick={() => void copySnippet()}>
          Copy Dataview snippet
        </Button>
      </div>
    </div>
  )
}
