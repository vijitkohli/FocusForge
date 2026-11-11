import { useEffect, useId, useRef, useState, type JSX } from 'react'
import type { AppSettings } from 'src/common/models'
import { Button, Checkbox, Skeleton } from '../ui'
import { ModelSelect } from './ModelSelect'

interface AISettingsProps {
  disabled?: boolean
  onPendingChange?: (pending: boolean) => void
}

export function AISettings({ disabled = false, onPendingChange }: AISettingsProps): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [failedPatch, setFailedPatch] = useState<Partial<AppSettings> | null>(null)
  const writePending = useRef(false)
  const id = useId()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    void window.api
      .getSettings()
      .then((result) => {
        if (!cancelled) setSettings(result)
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setLoadError(cause instanceof Error ? cause.message : "Couldn't load AI settings.")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [retry])

  async function update(patch: Partial<AppSettings>): Promise<void> {
    if (!settings || disabled || writePending.current) return
    writePending.current = true
    setSaving(true)
    onPendingChange?.(true)
    setSaved(false)
    setSaveError(null)
    try {
      const result = await window.api.saveSettings(patch)
      setSettings(result)
      setFailedPatch(null)
      setSaved(true)
    } catch (cause) {
      setFailedPatch(patch)
      setSaveError(cause instanceof Error ? cause.message : "Couldn't save AI settings.")
    } finally {
      writePending.current = false
      setSaving(false)
      onPendingChange?.(false)
    }
  }

  const busy = disabled || saving

  return (
    <section className="space-y-4 border-t border-line pt-6" aria-labelledby={`${id}-title`}>
      <div className="flex items-center gap-3">
        <h2 id={`${id}-title`} className="text-lg font-bold tracking-[-0.01em] text-fg-1">
          AI
        </h2>
        <span role="status" className="text-[12.5px] text-fg-3">
          {saving ? 'Saving…' : saved ? 'Saved' : ''}
        </span>
      </div>
      {loading ? (
        <div role="status" aria-label="Loading AI settings" aria-busy="true" className="space-y-4">
          <Skeleton height={56} />
          <Skeleton height={56} />
          <Skeleton width="60%" height={20} />
        </div>
      ) : loadError ? (
        <div role="alert" className="space-y-3 rounded-md bg-bg-2 p-4">
          <p className="text-sm text-hard">{loadError}</p>
          <Button disabled={busy} onClick={() => setRetry((value) => value + 1)}>
            Retry loading
          </Button>
        </div>
      ) : settings ? (
        <div className="space-y-4" aria-busy={saving}>
          <fieldset
            disabled={busy || failedPatch !== null}
            className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          >
            <div className="space-y-1.5">
              <ModelSelect
                label="Chat model"
                value={settings.chatModel}
                onChange={(chatModel) => void update({ chatModel })}
                disabled={busy || failedPatch !== null}
                aria-describedby={`${id}-chat-description`}
              />
              <p id={`${id}-chat-description`} className="text-[12.5px] leading-[1.55] text-fg-3">
                Chat model — asks the questions. Faster feels better.
              </p>
            </div>
            <div className="space-y-1.5">
              <ModelSelect
                label="Plan model"
                value={settings.planModel}
                onChange={(planModel) => void update({ planModel })}
                emptyOption={{ value: '', label: 'Same as chat model' }}
                disabled={busy || failedPatch !== null}
                aria-describedby={`${id}-plan-description`}
              />
              <p id={`${id}-plan-description`} className="text-[12.5px] leading-[1.55] text-fg-3">
                Plan model — builds and changes plans. Can be slower.
              </p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Checkbox
                label="Personalise nudges"
                checked={settings.aiNudges}
                onChange={(event) => void update({ aiNudges: event.target.checked })}
                disabled={busy || failedPatch !== null}
                aria-describedby={`${id}-nudges-description`}
              />
              <p id={`${id}-nudges-description`} className="text-[12.5px] leading-[1.55] text-fg-3">
                Uses AI for nudge notifications, with friendly templates if the model is
                unavailable.
              </p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Checkbox
                label="Weekly review"
                checked={settings.weeklyReview}
                onChange={(event) => void update({ weeklyReview: event.target.checked })}
                disabled={busy || failedPatch !== null}
                aria-describedby={`${id}-review-description`}
              />
              <p id={`${id}-review-description`} className="text-[12.5px] leading-[1.55] text-fg-3">
                A short, kind look back at your week every Sunday evening, shown in History.
              </p>
            </div>
          </fieldset>
          {saveError && failedPatch && (
            <div role="alert" className="space-y-3 rounded-md bg-bg-2 p-4">
              <p className="text-sm text-hard">{saveError} Your change has not been saved.</p>
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => void update(failedPatch)}>
                  Retry saving
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setFailedPatch(null)
                    setSaveError(null)
                  }}
                >
                  Discard change
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-fg-2">No AI settings were returned. Reload to try again.</p>
          <Button disabled={busy} onClick={() => setRetry((value) => value + 1)}>
            Retry loading
          </Button>
        </div>
      )}
    </section>
  )
}
