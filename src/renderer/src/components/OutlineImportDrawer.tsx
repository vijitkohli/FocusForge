import { useEffect, useRef, useState, type JSX } from 'react'
import { AlertCircle, FileText } from 'lucide-react'
import {
  candidateProblem,
  toCandidates,
  type OutlineCandidate,
  type OutlineReadResult
} from 'src/common/outline'
import type { ProjectTask } from 'src/common/types'
import { formatLocalDate } from '../lib/dates'
import { Button, Checkbox, DateInput, Drawer, EmptyState, Input } from '../ui'

export interface OutlineImportDrawerProps {
  projectId: string
  open: boolean
  tasks: readonly ProjectTask[]
  onClose: () => void
  /** Called after tasks were added, with how many. */
  onImported: (added: number) => void
}

type Phase =
  | { name: 'reading' }
  | { name: 'error'; message: string }
  | { name: 'review'; fileName: string; course: string }

const KIND_LABEL: Record<string, string> = {
  exam: 'Exam',
  assignment: 'Assignment',
  quiz: 'Quiz',
  lab: 'Lab',
  presentation: 'Presentation',
  other: 'Assessment'
}

/**
 * Course outline import: opens the native picker as soon as it's shown, reads
 * the PDF's graded assessments, and lets the student tick, rename and date
 * them before they become unplanned tasks. Nothing is saved until "Add".
 */
export function OutlineImportDrawer({
  projectId,
  open,
  tasks,
  onClose,
  onImported
}: OutlineImportDrawerProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ name: 'reading' })
  const [rows, setRows] = useState<OutlineCandidate[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showProblems, setShowProblems] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPhase({ name: 'reading' })
    setRows([])
    setSaveError(null)
    setShowProblems(false)
    window.api.readCourseOutline().then(
      (result: OutlineReadResult | null) => {
        if (cancelled) return
        if (!result || result.cancelled) {
          onClose()
          return
        }
        if (result.error || !result.assessments) {
          setPhase({ name: 'error', message: result.error || "Couldn't read that outline." })
          return
        }
        setRows(toCandidates(result.assessments, tasksRef.current))
        setPhase({ name: 'review', fileName: result.fileName, course: result.course ?? '' })
      },
      () => {
        if (!cancelled) setPhase({ name: 'error', message: "Couldn't read that outline." })
      }
    )
    return () => {
      cancelled = true
    }
    // onClose is a fresh closure each render; reading restarts only on open/retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, attempt])

  const update = (key: string, patch: Partial<OutlineCandidate>): void =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  const selected = rows.filter((row) => row.selected)
  const problems = selected.filter((row) => candidateProblem(row) !== null)

  const add = async (): Promise<void> => {
    if (phase.name !== 'review' || selected.length === 0) return
    if (problems.length > 0) {
      setShowProblems(true)
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const result = await window.api.importAssessments(
        projectId,
        phase.fileName,
        phase.course,
        selected.map((row) => ({
          title: row.title.trim(),
          dueDate: row.dueDate as string,
          when: row.when,
          weight: row.weight,
          kind: row.kind,
          notes: row.notes
        }))
      )
      if (!result.success) throw new Error(result.error || "The tasks weren't saved.")
      onImported(result.added)
      onClose()
    } catch (cause) {
      setSaveError(
        `${cause instanceof Error ? cause.message : "The tasks weren't saved."} Try again.`
      )
    } finally {
      setSaving(false)
    }
  }

  const close = (): void => {
    if (saving) return
    if (phase.name === 'reading') void window.api.cancelCourseOutline()
    onClose()
  }

  return (
    <Drawer
      open={open}
      onClose={close}
      title="Import course outline"
      description="Each graded assessment becomes a task you can plan with the coach."
    >
      {phase.name === 'reading' && (
        <div role="status" className="space-y-4">
          <p className="text-sm text-fg-2">Reading the outline for assessments and due dates…</p>
          <Button variant="secondary" onClick={close}>
            Stop
          </Button>
        </div>
      )}

      {phase.name === 'error' && (
        <div className="space-y-4">
          <div role="alert" className="flex items-start gap-2 rounded-md bg-bg-2 p-3 text-sm">
            <AlertCircle
              size={18}
              strokeWidth={1.75}
              aria-hidden="true"
              className="shrink-0 text-hard"
            />
            <p>{phase.message}</p>
          </div>
          <Button variant="primary" onClick={() => setAttempt((value) => value + 1)}>
            Choose another PDF
          </Button>
        </div>
      )}

      {phase.name === 'review' &&
        (rows.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No assessments found"
            description="Try another PDF, or add tasks with the coach."
          />
        ) : (
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault()
              void add()
            }}
          >
            <p className="text-sm text-fg-2">
              From <span className="text-fg-1">{phase.fileName}</span>
              {phase.course && ` · ${phase.course}`}. Untick anything you don&rsquo;t want as a
              task.
            </p>
            <ul className="space-y-4" aria-label="Assessments found">
              {rows.map((row) => {
                const problem = showProblems ? candidateProblem(row) : null
                const meta = [
                  KIND_LABEL[row.kind] ?? 'Assessment',
                  row.weight != null ? `${row.weight}%` : null,
                  !row.dueDate && row.when ? `outline says "${row.when}"` : null
                ]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <li key={row.key} className="space-y-2 border-b border-line pb-4">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        aria-label={`Import ${row.title || 'this assessment'}`}
                        checked={row.selected}
                        disabled={saving}
                        onChange={(event) => update(row.key, { selected: event.target.checked })}
                        className="mt-2"
                      />
                      <div className="min-w-0 flex-1 space-y-2">
                        <Input
                          aria-label="Assessment name"
                          value={row.title}
                          disabled={saving || !row.selected}
                          onChange={(event) => update(row.key, { title: event.target.value })}
                        />
                        <p className="text-[12.5px] text-fg-3">
                          {meta}
                          {row.existing && ' · already a task'}
                        </p>
                        {row.selected && (
                          <div className="w-[180px]">
                            <DateInput
                              label="Due"
                              pickerLabel={`Open calendar for ${row.title}`}
                              value={row.dueDate ?? ''}
                              disabled={saving}
                              error={problem ?? undefined}
                              onChange={(event) =>
                                update(row.key, { dueDate: event.target.value || null })
                              }
                            />
                          </div>
                        )}
                        {!row.selected && row.dueDate && (
                          <p className="text-[12.5px] text-fg-3">
                            Due {formatLocalDate(row.dueDate)}
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
            {showProblems && problems.length > 0 && (
              <p role="alert" className="text-sm text-fg-2">
                {problems.length === 1
                  ? 'One assessment needs a due date before it can be added.'
                  : `${problems.length} assessments need a due date before they can be added.`}
              </p>
            )}
            {saveError && (
              <p role="alert" className="text-sm text-fg-2">
                {saveError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="primary"
                loading={saving}
                loadingLabel="Adding tasks"
                disabled={selected.length === 0}
              >
                {selected.length === 1 ? 'Add 1 task' : `Add ${selected.length} tasks`}
              </Button>
              <Button variant="ghost" onClick={close} disabled={saving}>
                Cancel
              </Button>
            </div>
          </form>
        ))}
    </Drawer>
  )
}
