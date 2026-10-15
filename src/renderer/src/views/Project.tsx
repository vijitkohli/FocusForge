import { useCallback, useEffect, useState, type JSX } from 'react'
import { AlertCircle, ArrowLeft, ListMusic, NotebookText, Plus, Trash2 } from 'lucide-react'
import { localDateKey } from 'src/common/schedule'
import type { ProjectData, ProjectTask } from 'src/common/types'
import { formatLocalDate } from '../lib/dates'
import { queueStore } from '../lib/queue'
import type { NavigationProps } from '../shell/navigation'
import { Button, Cover, EmptyState, Menu, Skeleton } from '../ui'
import { ProjectNotesDrawer } from '../components/ProjectNotesDrawer'

export interface ProjectProps extends NavigationProps {
  projectId: string
}

export function Project(props: ProjectProps): JSX.Element {
  return <ProjectPage key={props.projectId} {...props} />
}

function ProjectPage({ projectId, onNavigate, onOpenProject }: ProjectProps): JSX.Element {
  const [data, setData] = useState<ProjectData | null>(null)
  const [lastActive, setLastActive] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void Promise.all([window.api.loadProjectData(projectId), window.api.getProjects()])
      .then(([project, summaries]) => {
        if (cancelled) return
        if (!project) throw new Error("Couldn't load this project. It may have been deleted.")
        setData(project)
        const summary = summaries.find((item) => item.id === projectId)
        const timestamp = summary?.lastActive || project.created
        const date = timestamp ? new Date(timestamp) : null
        setLastActive(
          date && !Number.isNaN(date.getTime()) ? formatLocalDate(localDateKey(date)) : ''
        )
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error ? cause.message : "Couldn't load this project. Try again."
          )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, retry])

  const openCoach = useCallback(
    () => onNavigate({ name: 'coach', projectId }),
    [onNavigate, projectId]
  )

  const remove = async (task: ProjectTask): Promise<void> => {
    if (deleting || !window.confirm(`Delete "${task.title}"? This can't be undone.`)) return
    setDeleting(task.id)
    setError(null)
    try {
      const result = await window.api.deleteTask(projectId, task.id)
      if (!result.success) throw new Error(result.error || "Couldn't delete this task. Try again.")
      setData((previous) =>
        previous
          ? { ...previous, tasks: previous.tasks.filter((item) => item.id !== task.id) }
          : previous
      )
      setLastActive(formatLocalDate(localDateKey(new Date())))
      try {
        await queueStore.refresh()
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : 'Try again.'
        setError(`Task deleted, but couldn't refresh the queue. ${detail}`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't delete this task. Try again.")
    } finally {
      setDeleting(null)
    }
  }

  const tasks = [...(data?.tasks ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const stepsLeft = tasks.reduce(
    (total, task) => total + (task.subtasks ?? []).filter((step) => !step.isCompleted).length,
    0
  )
  const name = data?.name || projectId.replace(/_/g, ' ')

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1360px] flex-col gap-8 px-8 py-8">
        <div>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={ArrowLeft}
            onClick={() => onNavigate({ name: 'library' })}
          >
            Library
          </Button>
        </div>
        {error && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-md bg-bg-2 p-4 text-sm"
          >
            <AlertCircle
              size={18}
              strokeWidth={1.75}
              className="shrink-0 text-hard"
              aria-hidden="true"
            />
            <p className="min-w-0 flex-1">{error}</p>
            <Button
              size="sm"
              variant="ghost"
              disabled={!!deleting}
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry loading
            </Button>
          </div>
        )}
        {loading ? (
          <div role="status" aria-label="Loading project" className="space-y-8">
            <div className="flex flex-wrap gap-6">
              <Skeleton className="size-[220px]" />
              <div className="space-y-4">
                <Skeleton className="h-9 w-56" />
                <Skeleton className="h-5 w-64" />
                <Skeleton className="h-9 w-48" />
              </div>
            </div>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </div>
        ) : (
          data && (
            <>
              <header className="flex flex-wrap items-end gap-6">
                <Cover projectId={projectId} name={name} size={220} />
                <div className="min-w-0 flex-1 space-y-4">
                  <h1 className="break-words text-[32px] leading-[1.15] font-[750] tracking-[-0.02em]">
                    {name}
                  </h1>
                  <p className="text-sm text-fg-2">
                    {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} · {stepsLeft} steps left
                    {lastActive && ` · last active ${lastActive}`}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" leadingIcon={Plus} onClick={openCoach}>
                      New task with coach
                    </Button>
                    <Button leadingIcon={NotebookText} onClick={() => setNotesOpen(true)}>
                      Project notes
                    </Button>
                  </div>
                </div>
              </header>
              {tasks.length === 0 ? (
                <EmptyState
                  icon={ListMusic}
                  title="No tasks yet"
                  description="Tell the coach what you need to do and make a plan you can start."
                  action={
                    <Button variant="primary" onClick={openCoach}>
                      New task with coach
                    </Button>
                  }
                />
              ) : (
                <section aria-label="Tasks in creation order">
                  <div className="grid grid-cols-[32px_minmax(0,1fr)_64px_100px_32px] gap-3 border-b border-line px-3 py-2 text-[12.5px] text-fg-3">
                    <span>#</span>
                    <span>Task</span>
                    <span>Steps</span>
                    <span>Due</span>
                    <span className="sr-only">Options</span>
                  </div>
                  <ol>
                    {tasks.map((task, index) => {
                      const steps = task.subtasks ?? []
                      return (
                        <li
                          key={task.id}
                          className="flex items-center gap-3 border-b border-line px-3 py-2.5 hover:bg-bg-2"
                        >
                          <button
                            className="grid min-w-0 flex-1 grid-cols-[32px_minmax(0,1fr)_64px_100px] items-center gap-3 text-left"
                            onClick={() => onOpenProject(projectId, task.id)}
                          >
                            <span className="text-sm tabular-nums text-fg-2">{index + 1}</span>
                            <span className="truncate text-[15px] leading-[1.35] font-[550]">
                              {task.title}
                            </span>
                            <span className="text-[12.5px] tabular-nums text-fg-2">
                              {steps.filter((step) => step.isCompleted).length} / {steps.length}
                            </span>
                            <span className="text-[12.5px] text-fg-2">
                              {formatLocalDate(task.deadline) || 'No deadline'}
                            </span>
                          </button>
                          <Menu
                            label={`Options for ${task.title}`}
                            disabled={!!deleting}
                            items={[
                              {
                                id: 'delete',
                                label: 'Delete task',
                                icon: Trash2,
                                danger: true,
                                onSelect: () => void remove(task)
                              }
                            ]}
                          />
                        </li>
                      )
                    })}
                  </ol>
                </section>
              )}
            </>
          )
        )}
      </div>
      <ProjectNotesDrawer
        projectId={projectId}
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
      />
    </div>
  )
}
