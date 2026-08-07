import React, { useState, useEffect, useCallback } from 'react'
import { USER_PROFILE_SECTIONS } from 'src/common/types'

const REQUIRED_SECTIONS = USER_PROFILE_SECTIONS.map((s) => `## ${s}`)

export function UserProfile(): React.JSX.Element {
  const [contents, setContents] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const text = await window.api.readUserProfile()
      setContents(text)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function startEdit() {
    setDraft(contents)
    setSaveError(null)
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
    setSaveError(null)
  }

  async function save() {
    const missing = REQUIRED_SECTIONS.filter((h) => !draft.includes(h))
    if (missing.length > 0) {
      setSaveError(`Missing required section(s): ${missing.join(', ')}`)
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const result = await window.api.saveUserProfile(draft)
      if (!result.success) {
        setSaveError(result.error ?? 'Save failed.')
      } else {
        setContents(draft)
        setEditing(false)
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleReset() {
    const confirmed = window.confirm(
      'This will permanently erase all projects, tasks, context, and your profile. Are you sure?'
    )
    if (!confirmed) return
    setResetting(true)
    setResetError(null)
    try {
      const result = await window.api.resetAllData()
      if (result.canceled) return
      if (!result.success) {
        setResetError(result.error ?? 'Reset failed.')
        return
      }
      window.location.reload()
    } finally {
      setResetting(false)
    }
  }

  // Split the profile into the user-editable block and the auto-generated overview
  function splitProfile(text: string): { editable: string; overview: string } {
    const overviewIdx = text.indexOf('## Projects Overview')
    if (overviewIdx === -1) return { editable: text, overview: '' }
    return {
      editable: text.slice(0, overviewIdx).trimEnd(),
      overview: text.slice(overviewIdx)
    }
  }

  const { editable, overview } = splitProfile(contents)

  return (
    <div className="flex flex-col gap-6 p-6 overflow-y-auto h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-fg-1">User Profile</h2>
          <p className="text-sm text-fg-3 mt-0.5">
            Injected into every AI call — helps the coach adapt to you.
          </p>
        </div>
        {!editing && (
          <button
            onClick={startEdit}
            className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition"
          >
            Edit
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-fg-3 text-sm">Loading…</div>
      ) : editing ? (
        /* Edit mode — only the user-editable sections */
        <div className="flex flex-col gap-3">
          <p className="text-xs text-fg-3">
            Keep the three headings (<code className="text-accent">## About Me</code>,{' '}
            <code className="text-accent">## Preferences</code>,{' '}
            <code className="text-accent">## Patterns &amp; Friction</code>). The{' '}
            <em>Projects Overview</em> section is auto-generated and shown read-only below.
          </p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="glass w-full rounded-xl px-4 py-3 font-mono text-sm text-fg-1 outline-none focus:ring-1 focus:ring-accent resize-none"
            rows={18}
          />
          {saveError && <p className="text-sm text-red-400">{saveError}</p>}
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={cancelEdit}
              className="rounded-full px-4 py-2 text-sm font-medium text-fg-2 hover:bg-surface transition"
            >
              Cancel
            </button>
          </div>
          {/* Auto-generated section shown read-only even in edit mode */}
          {overview && (
            <div className="glass rounded-xl px-4 py-3 mt-2">
              <p className="text-xs text-fg-3 mb-2 italic">Auto-generated — do not edit</p>
              <pre className="font-mono text-xs text-fg-2 whitespace-pre-wrap">{overview}</pre>
            </div>
          )}
        </div>
      ) : (
        /* Read mode */
        <div className="flex flex-col gap-4">
          <div className="glass rounded-xl px-4 py-3">
            <pre className="font-mono text-sm text-fg-1 whitespace-pre-wrap">
              {editable || '(empty — click Edit to add your profile)'}
            </pre>
          </div>
          {overview && (
            <div className="glass rounded-xl px-4 py-3">
              <p className="text-xs text-fg-3 mb-2 italic">
                Auto-generated — refreshed on every AI call
              </p>
              <pre className="font-mono text-sm text-fg-2 whitespace-pre-wrap">{overview}</pre>
            </div>
          )}
        </div>
      )}
      {/* Danger Zone */}
      <div className="mt-auto pt-6 border-t border-border">
        <p className="text-xs font-semibold uppercase tracking-widest text-fg-3 mb-3">
          Danger Zone
        </p>
        <div className="glass rounded-xl px-4 py-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-fg-1">Reset app / Erase all data</p>
            <p className="text-xs text-fg-3 mt-0.5">
              Permanently deletes every project, task, context ledger, and this profile. Cannot be
              undone.
            </p>
            {resetError && <p className="text-xs text-red-400 mt-1">{resetError}</p>}
          </div>
          <button
            onClick={handleReset}
            disabled={resetting}
            className="shrink-0 rounded-full border border-red-500/50 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
          >
            {resetting ? 'Erasing…' : 'Erase everything'}
          </button>
        </div>
      </div>
    </div>
  )
}
