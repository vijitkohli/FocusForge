import { useEffect, useRef, useState, type JSX } from 'react'
import { ChevronRight, FolderOpen, UserRound } from 'lucide-react'
import { parseLedger } from '../lib/ledger'
import { buildProfile, parseProfile, type ProfileSections } from '../lib/profileSections'
import { Button, EmptyState, Skeleton, Textarea } from '../ui'
import { AISettings } from './AISettings'

const PROFILE_FIELDS = [
  { section: 'About Me', label: 'About you' },
  { section: 'Preferences', label: 'Preferences' },
  { section: 'Patterns & Friction', label: 'What gets in your way' }
] as const

function plainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/\*([^*]+)\*|_([^_]+)_|`([^`]+)`/g, '$1$2$3')
    .replace(/^#{1,6}\s+/gm, '')
}

export function UserProfile(): JSX.Element {
  const [profile, setProfile] = useState(() => parseProfile(''))
  const [draft, setDraft] = useState<ProfileSections>(profile.sections)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  const [aiPending, setAiPending] = useState(false)
  const writePending = useRef(false)
  const aiWritePending = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    void window.api
      .readUserProfile()
      .then((text) => {
        if (cancelled) return
        const parsed = parseProfile(text)
        setProfile(parsed)
        setDraft(parsed.sections)
        setLoaded(true)
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setLoadError(cause instanceof Error ? cause.message : "Couldn't load your profile.")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [retry])

  async function save(): Promise<void> {
    if (!loaded || writePending.current || aiWritePending.current) return
    writePending.current = true
    setSaving(true)
    setSaved(false)
    setSaveError(null)
    try {
      const markdown = buildProfile(draft, profile.overview)
      const result = await window.api.saveUserProfile(markdown)
      if (!result.success) throw new Error(result.error || "Couldn't save your profile.")
      setProfile({ sections: { ...draft }, overview: profile.overview })
      setSaved(true)
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Couldn't save your profile.")
    } finally {
      writePending.current = false
      setSaving(false)
    }
  }

  async function openBackups(): Promise<void> {
    setBackupError(null)
    try {
      const result = await window.api.openBackupsFolder()
      if (!result.success) setBackupError(`Couldn't open the backups folder. ${result.error ?? ''}`)
    } catch {
      setBackupError("Couldn't open the backups folder.")
    }
  }

  async function handleReset(): Promise<void> {
    if (writePending.current || aiWritePending.current) return
    writePending.current = true
    setResetting(true)
    setResetError(null)
    try {
      const result = await window.api.resetAllData()
      if (result.canceled) return
      if (!result.success) throw new Error(result.error || "Couldn't erase your data.")
      window.location.reload()
    } catch (cause) {
      setResetError(cause instanceof Error ? cause.message : "Couldn't erase your data.")
    } finally {
      writePending.current = false
      setResetting(false)
    }
  }

  const busy = saving || resetting || aiPending
  const dirty = PROFILE_FIELDS.some(({ section }) => draft[section] !== profile.sections[section])
  const empty = PROFILE_FIELDS.every(({ section }) => !draft[section].trim())
  const overview = parseLedger(profile.overview).map((section) => ({
    ...section,
    entries: section.entries.filter(
      (entry) => entry.text.trim() && plainText(entry.text).trim() !== '(auto-generated)'
    )
  }))
  const hasOverview = overview.some((section) => section.entries.length > 0)

  return (
    <div className="h-full overflow-y-auto bg-bg-1 px-6 py-8">
      <div className="mx-auto max-w-[720px] space-y-8">
        <header>
          <h1 className="text-[32px] leading-[1.15] font-bold tracking-[-0.02em] text-fg-1">You</h1>
          <p className="mt-2 text-sm leading-[1.55] text-fg-2">
            Help the coach adapt to you. These details are shared with every AI call.
          </p>
        </header>

        {loading ? (
          <div
            role="status"
            aria-label="Loading your profile"
            aria-busy="true"
            className="space-y-4"
          >
            {PROFILE_FIELDS.map(({ section }) => (
              <div key={section} className="space-y-2">
                <Skeleton width="35%" height={18} />
                <Skeleton height={112} />
              </div>
            ))}
          </div>
        ) : loadError ? (
          <div role="alert" className="space-y-3 rounded-md bg-bg-2 p-4">
            <p className="text-sm text-hard">{loadError}</p>
            <Button onClick={() => setRetry((value) => value + 1)}>Retry loading</Button>
          </div>
        ) : loaded ? (
          <section className="space-y-5" aria-label="Your profile">
            {empty && (
              <EmptyState
                icon={UserRound}
                title="Tell the coach about you"
                description="Add what matters to you below. You can change it whenever you like."
                className="py-4"
              />
            )}
            <fieldset disabled={busy} className="space-y-5">
              {PROFILE_FIELDS.map(({ section, label }) => (
                <Textarea
                  key={section}
                  label={label}
                  value={draft[section]}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, [section]: event.target.value }))
                    setSaved(false)
                    setSaveError(null)
                  }}
                />
              ))}
              {saveError && (
                <p role="alert" className="text-sm text-hard">
                  {saveError}
                </p>
              )}
              <div className="flex items-center gap-3">
                <Button
                  variant="primary"
                  loading={saving}
                  loadingLabel="Saving your profile"
                  disabled={busy || (!dirty && !saveError)}
                  onClick={() => void save()}
                >
                  {saveError ? 'Retry saving' : 'Save changes'}
                </Button>
                {saved && (
                  <span role="status" className="text-sm text-easy">
                    Saved
                  </span>
                )}
              </div>
            </fieldset>
            <details className="group rounded-md border border-line p-4">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-fg-2 hover:text-fg-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  size={16}
                  aria-hidden="true"
                  className="transition-transform group-open:rotate-90 motion-reduce:transition-none"
                />
                What the coach knows about your projects
              </summary>
              <p className="mt-3 text-[12.5px] text-fg-3">
                Read-only. Refreshed when the coach uses your profile.
              </p>
              {hasOverview ? (
                <div className="mt-4 space-y-4">
                  {overview.map((section, index) => (
                    <section key={index}>
                      {section.heading && (
                        <h3 className="mb-2 text-sm font-medium text-fg-1">
                          {plainText(section.heading)}
                        </h3>
                      )}
                      <ul className="space-y-3">
                        {section.entries.map((entry, entryIndex) => {
                          const text = plainText(entry.text)
                          const colon = entry.bullet ? text.indexOf(': ') : -1
                          return (
                            <li
                              key={entryIndex}
                              className="text-sm leading-[1.55] whitespace-pre-wrap break-words text-fg-2"
                            >
                              {colon > 0 ? (
                                <>
                                  <p className="font-medium text-fg-1">{text.slice(0, colon)}</p>
                                  <p>{text.slice(colon + 2)}</p>
                                </>
                              ) : (
                                text
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={FolderOpen}
                  title="No project overview yet"
                  description="The coach builds this overview as you work on your projects."
                  className="py-6"
                />
              )}
            </details>
          </section>
        ) : null}

        <AISettings
          disabled={saving || resetting}
          onPendingChange={(pending) => {
            aiWritePending.current = pending
            setAiPending(pending)
          }}
        />

        <section
          className="space-y-3 border-t border-line pt-6"
          aria-labelledby="profile-backups-title"
        >
          <h2 id="profile-backups-title" className="text-lg font-bold tracking-[-0.01em] text-fg-1">
            Backups
          </h2>
          <p className="max-w-[72ch] text-sm leading-[1.55] text-fg-2">
            Each day, the first change to a project saves a copy of how it looked before. The last
            14 days are kept. Erasing all data removes these too.
          </p>
          {backupError && (
            <p role="alert" className="text-sm text-hard">
              {backupError}
            </p>
          )}
          <Button leadingIcon={FolderOpen} onClick={() => void openBackups()}>
            Show backups folder
          </Button>
        </section>

        <section
          className="space-y-3 border-t border-line pt-6"
          aria-labelledby="profile-reset-title"
        >
          <h2 id="profile-reset-title" className="text-lg font-bold tracking-[-0.01em] text-fg-1">
            Reset
          </h2>
          <p className="max-w-[72ch] text-sm leading-[1.55] text-fg-2">
            Permanently deletes every project, task, context ledger, and your profile. This cannot
            be undone.
          </p>
          {resetError && (
            <p role="alert" className="text-sm text-hard">
              {resetError} Try again below.
            </p>
          )}
          <Button
            variant="danger"
            loading={resetting}
            loadingLabel="Erasing all data"
            disabled={busy}
            onClick={() => void handleReset()}
          >
            Erase all data…
          </Button>
        </section>
      </div>
    </div>
  )
}
