import { useEffect, useRef, useState, type JSX } from 'react'
import { AlertCircle, NotebookText, Pencil } from 'lucide-react'
import { formatLocalDate } from '../lib/dates'
import { missingLedgerSections, parseLedger, type LedgerEntry } from '../lib/ledger'
import { Button, Drawer, EmptyState, Skeleton, Textarea } from '../ui'

export interface ProjectNotesDrawerProps {
  projectId: string
  open: boolean
  onClose: () => void
}

function NoteEntry({ entry, excerpt }: { entry: LedgerEntry; excerpt: boolean }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const date = entry.date ? formatLocalDate(entry.date) : ''
  return (
    <div className="min-w-0">
      {date && <p className="mb-1 text-[12.5px] text-fg-3">{date}</p>}
      <p
        className={`text-sm leading-[1.55] whitespace-pre-wrap break-words text-fg-2 ${excerpt && !expanded ? 'line-clamp-3' : ''}`}
      >
        {entry.text}
      </p>
      {excerpt && entry.text && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show all'}
        </Button>
      )}
    </div>
  )
}

export function ProjectNotesDrawer(props: ProjectNotesDrawerProps): JSX.Element {
  return <NotesDrawer key={props.projectId} {...props} />
}

function NotesDrawer({ projectId, open, onClose }: ProjectNotesDrawerProps): JSX.Element {
  const [ledger, setLedger] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const animation = panelRef.current?.animate(
      [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }],
      { duration: 200, easing: 'ease-out' }
    )
    return () => animation?.cancel()
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setLoaded(false)
    setEditing(false)
    setError(null)
    void window.api
      .readContextLedger(projectId)
      .then((contents) => {
        if (!cancelled) {
          setLedger(contents)
          setLoaded(true)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error ? cause.message : "Couldn't load project notes. Try again."
          )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, open, retry])

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.saveContextLedger(projectId, draft)
      if (!result.success)
        throw new Error(result.error || "Couldn't save project notes. Try again.")
      setLedger(draft)
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save project notes. Try again.")
    } finally {
      setSaving(false)
    }
  }

  const missing = editing ? missingLedgerSections(draft) : []
  const sections = parseLedger(ledger)
  const hasNotes = sections.some((section) => section.entries.some((entry) => entry.text.trim()))

  return (
    <Drawer
      ref={panelRef}
      open={open}
      onClose={() => {
        if (!saving) onClose()
      }}
      title="Project notes"
      description="Context the coach shares across this project's tasks."
    >
      <div className="space-y-6">
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-md bg-bg-2 p-3 text-sm">
            <AlertCircle
              size={18}
              strokeWidth={1.75}
              className="shrink-0 text-hard"
              aria-hidden="true"
            />
            <div>
              <p>{error}</p>
              {!loaded && (
                <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>
                  Retry loading
                </Button>
              )}
            </div>
          </div>
        )}
        {loading ? (
          <div role="status" aria-label="Loading project notes" className="space-y-4">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          loaded && (
            <>
              <div className="flex justify-end gap-2">
                {editing ? (
                  <>
                    <Button
                      variant="ghost"
                      disabled={saving}
                      onClick={() => {
                        setEditing(false)
                        setError(null)
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      loading={saving}
                      loadingLabel="Saving project notes"
                      onClick={() => void save()}
                    >
                      Save changes
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    leadingIcon={Pencil}
                    onClick={() => {
                      setDraft(ledger)
                      setEditing(true)
                      setError(null)
                    }}
                  >
                    Edit notes
                  </Button>
                )}
              </div>
              {editing ? (
                <div className="space-y-4">
                  {missing.length > 0 && (
                    <div
                      role="alert"
                      className="rounded-md border border-line-strong p-3 text-sm text-fg-2"
                    >
                      <p>These section headings are missing and auto-notes may duplicate them:</p>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {missing.map((heading) => (
                          <li key={heading}>
                            <code>## {heading}</code>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-2">
                        Restore the headings before saving, or save with this warning.
                      </p>
                    </div>
                  )}
                  <Textarea
                    label="Notes Markdown"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    disabled={saving}
                    spellCheck={false}
                    className="min-h-[360px] font-mono text-xs"
                  />
                </div>
              ) : hasNotes ? (
                <div className="space-y-8">
                  {sections.map((section, sectionIndex) => (
                    <section key={`${sectionIndex}-${section.heading}`}>
                      {section.heading && (
                        <h3 className="mb-3 text-lg leading-[1.3] font-bold tracking-[-0.01em]">
                          {section.heading}
                        </h3>
                      )}
                      {section.entries.length === 0 ? (
                        <p className="text-sm text-fg-3">Nothing recorded yet.</p>
                      ) : (
                        <ul className="space-y-4">
                          {section.entries.map((entry, index) => (
                            <li
                              key={`${index}-${entry.text}`}
                              className={entry.bullet ? 'ml-5 list-disc text-fg-2' : 'list-none'}
                            >
                              <NoteEntry
                                entry={entry}
                                excerpt={section.heading === 'Document Excerpts'}
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={NotebookText}
                  title="No project notes yet"
                  description="Attach a document or plan a task with the coach to build your project's context."
                />
              )}
            </>
          )
        )}
      </div>
    </Drawer>
  )
}
