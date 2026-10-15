import React, { useEffect, useState } from 'react'
import { LEDGER_SECTIONS } from 'src/common/types'

/**
 * View/edit the single combined context_<projectId>.md this project shares
 * across all its tasks (assignments, labs, etc). Loads fresh on mount.
 */
export function ContextLedgerPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const [contextLedger, setContextLedger] = useState('')
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api
      .readContextLedger(projectId)
      .then((ledger) => {
        if (!cancelled) setContextLedger(ledger)
      })
      .catch((e) => console.error('Failed to load context ledger', e))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const startEditing = (): void => {
    setDraft(contextLedger)
    setEditing(true)
  }

  const handleSave = async (): Promise<void> => {
    // Needed by appendLedgerNotes; saving without them risks duplicated sections.
    const missing = LEDGER_SECTIONS.filter((h) => !draft.includes(`## ${h}`))
    if (
      missing.length > 0 &&
      !window.confirm(
        `These section headings are missing and auto-notes may duplicate them:\n\n${missing
          .map((h) => `## ${h}`)
          .join('\n')}\n\nSave anyway?`
      )
    ) {
      return
    }

    setSaving(true)
    try {
      await window.api.saveContextLedger(projectId, draft)
      setContextLedger(draft)
      setEditing(false)
    } catch (e) {
      console.error('Failed to save context ledger', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="shrink-0 rounded-2xl glass p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-fg-2">Project Context</span>
        {editing ? (
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(false)}
              className="rounded-md px-3 py-1 text-xs text-fg-2 transition hover:text-fg-1"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : (
          <button
            onClick={startEditing}
            disabled={loading}
            className="rounded-md border border-border px-3 py-1 text-xs text-fg-2 transition hover:border-border-strong hover:text-fg-1 disabled:opacity-50"
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="h-64 w-full resize-none rounded-lg border border-border bg-bg-3 p-3 font-mono text-xs text-fg-1 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
        />
      ) : (
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-fg-2">
          {loading
            ? 'Loading…'
            : contextLedger.trim()
              ? contextLedger
              : 'No context recorded yet for this project.'}
        </pre>
      )}
    </div>
  )
}
