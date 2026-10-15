import React, { useEffect, useState } from 'react'
import { AppSettings } from 'src/common/models'
import { ModelSelect } from './ModelSelect'

/**
 * Persisted AI preferences (system/settings.json): which model runs the intake
 * chat, an optional stronger model for building/adjusting plans, and whether
 * nudge notifications get LLM-personalised copy. Saves on every change.
 */
export function AISettings(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.api.getSettings().then(setSettings)
  }, [])

  const update = async (patch: Partial<AppSettings>): Promise<void> => {
    if (!settings) return
    setSettings({ ...settings, ...patch })
    setSettings(await window.api.saveSettings(patch))
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-fg-3">AI</p>
        {saved && <span className="text-xs text-easy">Saved</span>}
      </div>
      {!settings ? (
        <div className="text-sm text-fg-3">Loading…</div>
      ) : (
        <div className="glass grid grid-cols-2 gap-4 rounded-xl px-4 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-fg-1">Chat model</span>
            <span className="text-xs text-fg-3">Asks the intake questions. Fast is best.</span>
            <ModelSelect value={settings.chatModel} onChange={(chatModel) => update({ chatModel })} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-fg-1">Plan model</span>
            <span className="text-xs text-fg-3">Builds and adjusts checklists. Can be stronger/slower.</span>
            <ModelSelect
              value={settings.planModel}
              onChange={(planModel) => update({ planModel })}
              emptyOption={{ value: '', label: 'Same as chat model' }}
            />
          </label>
          <label className="col-span-2 flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={settings.aiNudges}
              onChange={(e) => update({ aiNudges: e.target.checked })}
              className="h-4 w-4 cursor-pointer accent-accent"
            />
            <span className="text-sm text-fg-1">Personalise nudge notifications with AI</span>
            <span className="text-xs text-fg-3">(falls back to friendly templates if the model is unavailable)</span>
          </label>
        </div>
      )}
    </div>
  )
}
