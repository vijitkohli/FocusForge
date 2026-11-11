import { useEffect, useRef, useState, type JSX } from 'react'
import { AlertCircle, ArrowLeft, MessageSquare } from 'lucide-react'
import {
  overdueSubtasks,
  redistributeSchedule,
  rescheduleOverdue
} from '../../../../common/schedule'
import {
  deriveStatus,
  setSubtaskStatus,
  withCompletion,
  type LedgerNote,
  type ProjectTask,
  type Subtask,
  type SubtaskStatus
} from '../../../../common/types'
import type { NavigationProps } from '../../shell/navigation'
import { queueStore } from '../../lib/queue'
import { Button, EmptyState, SegmentedControl, Skeleton } from '../../ui'
import { isUnplanned } from '../../../../common/outline'
import { seriesTemplate } from '../../../../common/recurrence'
import { formatLocalDate } from '../../lib/dates'
import { RepeatDrawer } from './RepeatDrawer'
import { KanbanBoard } from '../../components/KanbanBoard'
import { ProjectNotesDrawer } from '../../components/ProjectNotesDrawer'
import { TaskHeader } from './TaskHeader'
import { ReplanBanner } from './ReplanBanner'
import { Prerequisites } from './Prerequisites'
import { AddStep, StepList } from './StepList'
import { AdjustPlan } from './AdjustPlan'
import { persistTaskChange, type TaskChange } from './persistTaskChange'
import './task.css'

export interface TaskPageProps extends NavigationProps {
  projectId: string
  taskId: string
}

type Failure = { message: string; retry: () => void }

export function TaskPage(props: TaskPageProps): JSX.Element {
  return <CurrentTask key={JSON.stringify([props.projectId, props.taskId])} {...props} />
}

function CurrentTask({ projectId, taskId, onNavigate, onOpenFocus }: TaskPageProps): JSX.Element {
  const [task, setTask] = useState<ProjectTask | null>(null)
  const [projectName, setProjectName] = useState(projectId.replace(/_/g, ' '))
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [splitNotice, setSplitNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<'saving' | 'adjusting' | 'splitting' | 'deleting' | null>(null)
  const [view, setView] = useState<'list' | 'board'>('list')
  const [notesOpen, setNotesOpen] = useState(false)
  const [repeatOpen, setRepeatOpen] = useState(false)
  const [series, setSeries] = useState<ProjectTask | null>(null)
  const [request, setRequest] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  // A ref closes the Enter/blur and rapid-click gap before React disables controls.
  const writing = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailure(null)
    void window.api
      .loadProjectData(projectId)
      .then((project) => {
        if (cancelled) return
        const current = project?.tasks.find((item) => item.id === taskId)
        if (!current) throw new Error('This task could not be found. It may have been deleted.')
        setTask(current)
        setSeries(seriesTemplate(project?.tasks ?? [], current) ?? null)
        setProjectName(project?.name || projectId.replace(/_/g, ' '))
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setFailure({
            message: `Couldn't load this task. ${errorText(cause)}`,
            retry: () => setReload((value) => value + 1)
          })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, taskId, reload])

  const back = (): void => onNavigate({ name: 'project', projectId })

  const refreshQueue = async (): Promise<void> => {
    try {
      await queueStore.refresh()
    } catch (cause) {
      if (mounted.current)
        setFailure({
          message: `Your change was saved, but the shared queue couldn't refresh. ${errorText(cause)}`,
          retry: () => {
            setFailure(null)
            void refreshQueue()
          }
        })
    }
  }

  const run = async (
    kind: NonNullable<typeof busy>,
    label: string,
    operation: () => Promise<void>
  ): Promise<void> => {
    if (writing.current) return
    writing.current = true
    setBusy(kind)
    setFailure(null)
    try {
      await operation()
    } catch (cause) {
      if (mounted.current)
        setFailure({
          message: `${label} ${errorText(cause)}`,
          retry: () => void run(kind, label, operation)
        })
    } finally {
      writing.current = false
      if (mounted.current) setBusy(null)
    }
  }

  const save = (label: string, change: TaskChange, note: LedgerNote): void => {
    void run('saving', label, async () => {
      const saved = await persistTaskChange(projectId, taskId, change, note)
      if (mounted.current) setTask(saved)
      await refreshQueue()
    })
  }

  const toggleStep = (id: string): void => {
    const target = task?.subtasks.find((step) => step.id === id)
    if (!target) return
    const completed = !target.isCompleted
    save(
      `Couldn't ${completed ? 'complete' : 'reopen'} this step.`,
      (current) => ({
        ...current,
        subtasks: current.subtasks.map((step) =>
          step.id === id ? withCompletion(step, completed) : step
        )
      }),
      {
        section: 'Milestones & Completed Work',
        note: `Marked "${target.title}" as ${completed ? 'complete' : 'incomplete'}.`
      }
    )
  }

  const moveStep = (id: string, status: SubtaskStatus): void => {
    const target = task?.subtasks.find((step) => step.id === id)
    if (!target || deriveStatus(target) === status) return
    save(
      "Couldn't move this step.",
      (current) => ({
        ...current,
        subtasks: current.subtasks.map((step) =>
          step.id === id ? setSubtaskStatus(step, status) : step
        )
      }),
      {
        section: 'Milestones & Completed Work',
        note: `Moved "${target.title}" to ${status === 'todo' ? 'To do' : status === 'doing' ? 'Doing' : 'Done'}.`
      }
    )
  }

  const togglePrerequisite = (id: string): void => {
    const target = task?.prerequisites?.find((item) => item.id === id)
    if (!target) return
    const completed = !target.isCompleted
    save(
      "Couldn't save this prerequisite.",
      (current) => ({
        ...current,
        prerequisites: (current.prerequisites ?? []).map((item) =>
          item.id === id ? { ...item, isCompleted: completed } : item
        )
      }),
      {
        section: 'Milestones & Completed Work',
        note: `Prerequisite "${target.title}" marked ${completed ? 'complete' : 'incomplete'}.`
      }
    )
  }

  const editStep = (id: string, title: string): void => {
    const target = task?.subtasks.find((step) => step.id === id)
    if (!target || !title.trim() || title.trim() === target.title) return
    save(
      "Couldn't edit this step.",
      (current) => ({
        ...current,
        subtasks: current.subtasks.map((step) =>
          step.id === id ? { ...step, title: title.trim() } : step
        )
      }),
      {
        section: 'Milestones & Completed Work',
        note: `Manually edited subtask: "${target.title}" -> "${title.trim()}".`
      }
    )
  }

  const deleteStep = (id: string): void => {
    const target = task?.subtasks.find((step) => step.id === id)
    if (!target) return
    save(
      "Couldn't delete this step.",
      (current) => ({ ...current, subtasks: current.subtasks.filter((step) => step.id !== id) }),
      {
        section: 'Milestones & Completed Work',
        note: `Manually deleted subtask: "${target.title}".`
      }
    )
  }

  const splitStep = (id: string): void => {
    void run('splitting', "Couldn't split this step.", async () => {
      setMessage(null)
      const result = await window.api.splitStep(projectId, taskId, id)
      if (result.cancelled) return
      if (!result.success) throw new Error(result.message)
      const project = await window.api.loadProjectData(projectId)
      const saved = project?.tasks.find((item) => item.id === taskId)
      if (mounted.current) {
        if (saved) setTask(saved)
        setSplitNotice(result.message)
      }
      await refreshQueue()
    })
  }

  const addStep = (title: string): void => {
    if (!title.trim()) return
    const step: Subtask = {
      id: `manual-${crypto.randomUUID()}`,
      title: title.trim(),
      isCompleted: false
    }
    save(
      "Couldn't add this step.",
      (current) => ({
        ...current,
        subtasks: current.subtasks.some((item) => item.id === step.id)
          ? current.subtasks
          : [...current.subtasks, step]
      }),
      {
        section: 'Milestones & Completed Work',
        note: `Manually added subtask: "${step.title}".`
      }
    )
  }

  const deadlineChange = (deadline: string): void => {
    if (!task || deadline === task.deadline) return
    save(
      "Couldn't change the deadline.",
      (current) => ({
        ...current,
        deadline,
        subtasks: redistributeSchedule(current.subtasks, deadline)
      }),
      {
        section: 'Plan Adjustments',
        note: `Deadline changed from ${task.deadline} to ${deadline}; remaining steps rescheduled.`
      }
    )
  }

  const replan = (): void => {
    if (!task) return
    const { moved } = rescheduleOverdue(task.subtasks, task.deadline)
    if (!moved) return
    save(
      "Couldn't re-plan slipped steps.",
      (current) => ({
        ...current,
        subtasks: rescheduleOverdue(current.subtasks, current.deadline).subtasks
      }),
      {
        section: 'Plan Adjustments',
        note: `Re-planned ${moved} overdue step${moved === 1 ? '' : 's'} forward from today.`
      }
    )
  }

  const adjust = (): void => {
    const instruction = request.trim()
    if (!task || !instruction) return
    void run('adjusting', "Couldn't adjust this plan.", async () => {
      setMessage(null)
      const result = await window.api.updateChecklist(
        projectId,
        taskId,
        instruction,
        {
          originalTask: task.title,
          subtasks: task.subtasks,
          prerequisites: task.prerequisites ?? []
        },
        task.deadline,
        task.depth,
        task.model
      )
      if (result.cancelled) return
      if (!result.success || !result.subtasks)
        throw new Error(result.message || 'The coach returned no updated plan. Try again.')
      // Verify persistence: the legacy IPC handler can return success after a failed disk write.
      const project = await window.api.loadProjectData(projectId)
      const saved = project?.tasks.find((item) => item.id === taskId)
      if (
        !saved ||
        JSON.stringify(saved.subtasks) !== JSON.stringify(result.subtasks) ||
        JSON.stringify(saved.prerequisites ?? []) !== JSON.stringify(result.prerequisites ?? [])
      ) {
        throw new Error('The adjusted plan was not saved to disk. Try again.')
      }
      if (mounted.current) {
        setTask(saved)
        setMessage(result.message)
        setRequest('')
      }
      await refreshQueue()
    })
  }

  const deleteTask = (): void => {
    if (
      !task ||
      writing.current ||
      !window.confirm(`Delete "${task.title}"? This can't be undone.`)
    )
      return
    void run('deleting', "Couldn't delete this task.", async () => {
      const result = await window.api.deleteTask(projectId, taskId)
      if (!result.success) throw new Error(result.error || 'The task was not deleted. Try again.')
      await refreshQueue()
      if (mounted.current) back()
    })
  }

  const setRepeat = async (weekday: number | null, until = ''): Promise<void> => {
    const result = await window.api.setRecurrence(projectId, taskId, weekday, until)
    if (!result.success) throw new Error(result.error || "Couldn't save the weekly repeat.")
    setReload((value) => value + 1)
    await refreshQueue()
  }

  const stopRepeating = (): void => {
    void run('saving', "Couldn't stop repeating.", () => setRepeat(null))
  }

  const disabled = !!busy
  return (
    <div className="h-full min-w-0 overflow-y-auto bg-bg-1">
      <div className="mx-auto flex w-full min-w-0 max-w-[1120px] flex-col gap-8 px-4 py-6 sm:px-8 sm:py-8">
        {failure && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-md bg-bg-2 p-4 text-sm text-fg-2"
          >
            <AlertCircle size={18} className="text-hard" aria-hidden="true" />
            <p className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">{failure.message}</p>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || loading}
              onClick={failure.retry}
            >
              Retry
            </Button>
          </div>
        )}
        {loading ? (
          <div role="status" aria-label="Loading task" className="space-y-6">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-12 w-full" />
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </div>
        ) : task ? (
          <>
            <TaskHeader
              task={task}
              projectName={projectName}
              disabled={disabled}
              onBack={back}
              onPlay={() => onOpenFocus({ scope: 'task', projectId, taskId })}
              onNotes={() => setNotesOpen(true)}
              onDelete={deleteTask}
              onDeadline={deadlineChange}
              repeating={!!series?.recurrence}
              onRepeat={() => setRepeatOpen(true)}
              onStopRepeating={stopRepeating}
            />
            {series?.recurrence && (
              <p className="meta -mt-4 text-fg-2">
                Repeats every{' '}
                {
                  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
                    series.recurrence.weekday
                  ]
                }{' '}
                until {formatLocalDate(series.recurrence.until)}
              </p>
            )}
            {isUnplanned(task) && (
              <EmptyState
                icon={MessageSquare}
                title="Not planned yet"
                description={[
                  task.assessment?.weight != null ? `Worth ${task.assessment.weight}%.` : '',
                  task.assessment?.notes ?? '',
                  'The coach will break it into small steps you can start.'
                ]
                  .filter(Boolean)
                  .join(' ')}
                action={
                  <Button
                    variant="primary"
                    disabled={disabled}
                    onClick={() => onNavigate({ name: 'coach', projectId, planTaskId: task.id })}
                  >
                    Plan with coach
                  </Button>
                }
              />
            )}
            <ReplanBanner
              count={overdueSubtasks(task.subtasks).length}
              disabled={disabled}
              onReplan={replan}
            />
            <Prerequisites
              items={task.prerequisites ?? []}
              disabled={disabled}
              onToggle={togglePrerequisite}
            />
            <section aria-labelledby="task-steps-title" className="min-w-0">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 id="task-steps-title" className="section-title">
                  Steps
                </h2>
                <SegmentedControl
                  label="Step view"
                  value={view}
                  onChange={setView}
                  disabled={disabled}
                  options={[
                    { value: 'list', label: 'List' },
                    { value: 'board', label: 'Board' }
                  ]}
                />
              </div>
              {busy === 'splitting' ? (
                <div
                  role="status"
                  className="mb-3 flex flex-wrap items-center gap-3 text-sm text-fg-2"
                >
                  Breaking that step into smaller ones…
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void window.api.cancelSplitStep()}
                  >
                    Stop
                  </Button>
                </div>
              ) : (
                splitNotice && (
                  <p role="status" className="mb-3 text-sm text-fg-2">
                    {splitNotice}
                  </p>
                )
              )}
              {view === 'list' ? (
                <StepList
                  items={task.subtasks}
                  disabled={disabled}
                  onToggle={toggleStep}
                  onEdit={editStep}
                  onDelete={deleteStep}
                  onSplit={splitStep}
                  onAdd={addStep}
                />
              ) : (
                <>
                  <KanbanBoard subtasks={task.subtasks} onMove={moveStep} disabled={disabled} />
                  <AddStep disabled={disabled} onAdd={addStep} />
                </>
              )}
            </section>
            <AdjustPlan
              request={request}
              message={message}
              disabled={disabled}
              adjusting={busy === 'adjusting'}
              onChange={setRequest}
              onAdjust={adjust}
              onStop={() => void window.api.cancelPlanAdjustment()}
            />
          </>
        ) : (
          <Button variant="ghost" leadingIcon={ArrowLeft} onClick={back}>
            Back to project
          </Button>
        )}
      </div>
      {task && repeatOpen && (
        <RepeatDrawer
          open={repeatOpen}
          task={series ?? task}
          onClose={() => setRepeatOpen(false)}
          onSave={(weekday, until) => setRepeat(weekday, until)}
        />
      )}
      <ProjectNotesDrawer
        projectId={projectId}
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
      />
    </div>
  )
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
