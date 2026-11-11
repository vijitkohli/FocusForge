import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { AlertCircle, LibraryBig, Plus, Trash2 } from 'lucide-react'
import { localDateKey } from 'src/common/schedule'
import { coverFor } from '../lib/cover'
import { formatLocalDate } from '../lib/dates'
import { queueStore } from '../lib/queue'
import type { NavigationProps } from '../shell/navigation'
import { Button, Cover, EmptyState, Input, Menu, Skeleton } from '../ui'

export interface LibraryProps extends NavigationProps {
  focusNewProject?: boolean
}

interface LibraryProject {
  id: string
  name: string
  progress: number
  lastActive: string
  taskCount: number
}

function activeLabel(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '' : formatLocalDate(localDateKey(date))
}

export function Library({ onOpenProject, focusNewProject = false }: LibraryProps): JSX.Element {
  const [projects, setProjects] = useState<LibraryProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(focusNewProject)
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      const summaries: Omit<LibraryProject, 'taskCount'>[] = await window.api.getProjects()
      const list = await Promise.all(
        summaries.map(async (project) => {
          const data = await window.api.loadProjectData(project.id)
          if (!data) throw new Error(`Couldn't load "${project.name}". Try again.`)
          return { ...project, taskCount: (data.tasks ?? []).length }
        })
      )
      if (request !== requestRef.current) return
      setProjects(list)
      if (list.length === 0) setShowCreate(true)
    } catch (cause) {
      if (request === requestRef.current)
        setError(cause instanceof Error ? cause.message : "Couldn't load your projects. Try again.")
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [])

  const cancelRequests = useCallback((): void => {
    requestRef.current++
  }, [])

  useEffect(() => {
    void load()
    return cancelRequests
  }, [load, cancelRequests])

  useEffect(() => {
    if (showCreate && !loading) inputRef.current?.focus()
  }, [showCreate, loading])

  const create = async (): Promise<void> => {
    if (creating || !name.trim()) return
    const trimmed = name.trim()
    const id = trimmed.replace(/[^a-z0-9]/gi, '_')
    setCreating(true)
    setError(null)
    try {
      // Recheck the registry: creating an existing normalized ID overwrites its files.
      const current: { id: string }[] = await window.api.getProjects()
      if (current.some((project) => project.id === id)) {
        throw new Error('A project with that name already exists. Choose a different name.')
      }
      const project = await window.api.createProject(trimmed)
      if (!project?.id) throw new Error("Couldn't create this project. Try again.")
      setProjects((previous) => [...previous, { ...project, taskCount: 0 }])
      setName('')
      setShowCreate(false)
      window.dispatchEvent(new CustomEvent('focusforge:projects-changed'))
      onOpenProject(project.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't create this project. Try again.")
    } finally {
      setCreating(false)
    }
  }

  const remove = async (project: LibraryProject): Promise<void> => {
    if (
      deleting ||
      !window.confirm(
        `Delete "${project.name}"? This removes all its tasks and context permanently.`
      )
    )
      return
    setDeleting(project.id)
    setError(null)
    try {
      const result = await window.api.deleteProject(project.id)
      if (!result.success)
        throw new Error(result.error || "Couldn't delete this project. Try again.")
      setProjects((previous) => previous.filter((item) => item.id !== project.id))
      if (projects.length === 1) setShowCreate(true)
      window.dispatchEvent(new CustomEvent('focusforge:projects-changed'))
      try {
        await queueStore.refresh()
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : 'Try again.'
        setError(`Project deleted, but couldn't refresh the queue. ${detail}`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't delete this project. Try again.")
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1360px] flex-col gap-8 px-8 py-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-[32px] leading-[1.15] font-[750] tracking-[-0.02em]">Library</h1>
          <Button
            variant="primary"
            leadingIcon={Plus}
            onClick={() => {
              setShowCreate(true)
              inputRef.current?.focus()
            }}
            disabled={loading || creating}
          >
            New project
          </Button>
        </header>
        {showCreate && !loading && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <div className="min-w-0 flex-1 sm:max-w-80">
              <Input
                ref={inputRef}
                label="Project name"
                value={name}
                placeholder="For example, COMP6991"
                disabled={creating}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !creating) {
                    event.preventDefault()
                    setShowCreate(false)
                    setName('')
                    setError(null)
                  }
                }}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              loading={creating}
              loadingLabel="Creating project"
              disabled={!name.trim()}
            >
              Create
            </Button>
            <Button
              variant="ghost"
              disabled={creating}
              onClick={() => {
                setShowCreate(false)
                setName('')
              }}
            >
              Cancel
            </Button>
          </form>
        )}
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
              onClick={() => void load()}
              disabled={creating || !!deleting}
            >
              Retry loading
            </Button>
          </div>
        )}
        {loading ? (
          <div
            aria-label="Loading projects"
            role="status"
            className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-6"
          >
            {[0, 1, 2].map((index) => (
              <div key={index} className="space-y-3">
                <Skeleton className="h-[220px] max-w-[220px]" />
                <Skeleton className="h-5 w-36" />
                <Skeleton className="h-4 w-44" />
              </div>
            ))}
          </div>
        ) : projects.length === 0 && !error ? (
          <EmptyState
            icon={LibraryBig}
            title="Your library starts here"
            description="Create a project, then tell the coach what you're avoiding."
            action={
              !showCreate ? (
                <Button variant="primary" onClick={() => setShowCreate(true)}>
                  New project
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-6">
            {projects.map((project) => {
              const progress = Math.max(0, Math.min(100, project.progress || 0))
              const active = activeLabel(project.lastActive)
              return (
                <article key={project.id} className="min-w-0">
                  <button
                    className="group block w-full text-left"
                    onClick={() => onOpenProject(project.id)}
                    aria-label={`Open ${project.name}`}
                  >
                    <Cover
                      projectId={project.id}
                      name={project.name}
                      size={220}
                      decorative
                      className="max-w-full group-hover:brightness-[1.06]"
                      style={{ aspectRatio: '1', height: 'auto' }}
                    />
                    <div
                      className="mt-2 h-[3px] w-[220px] max-w-full overflow-hidden rounded-full bg-bg-3"
                      role="progressbar"
                      aria-label={`${project.name} progress`}
                      aria-valuenow={progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="h-full"
                        style={{
                          width: `${progress}%`,
                          backgroundColor: `var(--color-${coverFor(project.id, project.name).hue})`
                        }}
                      />
                    </div>
                    <h2 className="mt-3 truncate text-[15px] leading-[1.35] font-[550] text-fg-2 group-hover:text-fg-1">
                      {project.name}
                    </h2>
                  </button>
                  <div className="mt-1 flex items-start justify-between gap-2">
                    <div className="min-w-0 text-[12.5px] leading-[1.4]">
                      <p className="text-fg-2">
                        {project.taskCount} {project.taskCount === 1 ? 'task' : 'tasks'} ·{' '}
                        {progress}% done
                      </p>
                      <p className="mt-1 text-fg-3">
                        {active ? `Active ${active}` : 'No activity yet'}
                      </p>
                    </div>
                    <Menu
                      label={`Options for ${project.name}`}
                      disabled={!!deleting || creating}
                      items={[
                        {
                          id: 'delete',
                          label: 'Delete project',
                          icon: Trash2,
                          danger: true,
                          onSelect: () => void remove(project)
                        }
                      ]}
                    />
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
