import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import {
  AlertCircle,
  Archive,
  ChevronRight,
  CirclePause,
  CirclePlay,
  FolderSearch,
  LibraryBig,
  Plus,
  Trash2
} from 'lucide-react'
import { localDateKey } from 'src/common/schedule'
import type { Workstream, WorkstreamStatus } from 'src/common/types'
import {
  CATEGORIES,
  groupByCategory,
  withWorkstreamDefaults,
  type ItemCategory
} from 'src/common/workstreams'
import { coverFor } from '../lib/cover'
import { formatLocalDate } from '../lib/dates'
import { queueStore } from '../lib/queue'
import type { NavigationProps } from '../shell/navigation'
import { Button, Cover, EmptyState, Input, Menu, Select, Skeleton, type MenuItem } from '../ui'

export interface LibraryProps extends NavigationProps {
  focusNewProject?: boolean
}

type LibraryProject = Workstream & { taskCount: number }

function activeLabel(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '' : formatLocalDate(localDateKey(date))
}

export function Library({
  onOpenProject,
  onNavigate,
  focusNewProject = false
}: LibraryProps): JSX.Element {
  const [projects, setProjects] = useState<LibraryProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(focusNewProject)
  const [name, setName] = useState('')
  const [category, setCategory] = useState<ItemCategory>('Learning')
  const [showArchived, setShowArchived] = useState(false)
  const [discoveryDone, setDiscoveryDone] = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      const summaries = (await window.api.getProjects()).map(withWorkstreamDefaults)
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
    let cancelled = false
    void window.api.getSettings().then(
      (settings) => {
        if (!cancelled) setDiscoveryDone(settings.discoveryCompletedAt != null)
      },
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [])

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
        throw new Error('An item with that name already exists. Choose a different name.')
      }
      const project = await window.api.createProject(trimmed, { category })
      if (!project?.id) throw new Error("Couldn't create this item. Try again.")
      setProjects((previous) => [...previous, { ...withWorkstreamDefaults(project), taskCount: 0 }])
      setName('')
      setShowCreate(false)
      window.dispatchEvent(new CustomEvent('focusforge:projects-changed'))
      onOpenProject(project.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't create this item. Try again.")
    } finally {
      setCreating(false)
    }
  }

  const setStatus = async (project: LibraryProject, status: WorkstreamStatus): Promise<void> => {
    if (updating) return
    setUpdating(project.id)
    setError(null)
    try {
      const result = await window.api.updateWorkstream(project.id, { status })
      if (!result.success) throw new Error("Couldn't change this item. Try again.")
      setProjects((previous) =>
        previous.map((item) => (item.id === project.id ? { ...item, status } : item))
      )
      window.dispatchEvent(new CustomEvent('focusforge:projects-changed'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change this item. Try again.")
    } finally {
      setUpdating(null)
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

  const archived = projects.filter((p) => p.status === 'archived')

  const statusItems = (project: LibraryProject): MenuItem[] => {
    const items: MenuItem[] = []
    if (project.status !== 'active')
      items.push({
        id: 'activate',
        label: 'Make active',
        icon: CirclePlay,
        onSelect: () => void setStatus(project, 'active')
      })
    if (project.status === 'active')
      items.push({
        id: 'pause',
        label: 'Pause',
        icon: CirclePause,
        onSelect: () => void setStatus(project, 'paused')
      })
    if (project.status !== 'archived')
      items.push({
        id: 'archive',
        label: 'Archive',
        icon: Archive,
        onSelect: () => void setStatus(project, 'archived')
      })
    return items
  }

  const renderGrid = (list: LibraryProject[]): JSX.Element => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-6">
      {list.map((project) => {
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
              <h3 className="mt-3 truncate text-[15px] leading-[1.35] font-[550] text-fg-2 group-hover:text-fg-1">
                {project.name}
              </h3>
            </button>
            <div className="mt-1 flex items-start justify-between gap-2">
              <div className="min-w-0 text-[12.5px] leading-[1.4]">
                <p className="text-fg-2">
                  {project.taskCount} {project.taskCount === 1 ? 'task' : 'tasks'} · {progress}%
                  done
                </p>
                <p className="mt-1 text-fg-3">{active ? `Active ${active}` : 'No activity yet'}</p>
                {project.status !== 'active' && (
                  <p className="mt-1 inline-flex rounded-full border border-line px-2 py-0.5 text-[12px] text-fg-2">
                    {project.status === 'paused' ? 'Paused' : 'Archived'}
                  </p>
                )}
              </div>
              <Menu
                label={`Options for ${project.name}`}
                disabled={!!deleting || creating || !!updating}
                items={[
                  ...statusItems(project),
                  {
                    id: 'delete',
                    label: 'Delete item',
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
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1360px] flex-col gap-8 px-8 py-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-[32px] leading-[1.15] font-[750] tracking-[-0.02em]">Library</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Button leadingIcon={FolderSearch} onClick={() => onNavigate({ name: 'items' })}>
              Find your items
            </Button>
            <Button
              variant="primary"
              leadingIcon={Plus}
              onClick={() => {
                setShowCreate(true)
                inputRef.current?.focus()
              }}
              disabled={loading || creating}
            >
              New item
            </Button>
          </div>
        </header>
        {!discoveryDone && (
          <div className="flex flex-wrap items-center gap-3 rounded-md bg-bg-2 p-4 text-sm">
            <FolderSearch
              size={18}
              strokeWidth={1.75}
              className="shrink-0 text-fg-2"
              aria-hidden="true"
            />
            <p className="min-w-0 flex-1 text-fg-1">
              Want me to look through your folders for courses and projects? I only read names and
              dates.
            </p>
            <Button size="sm" variant="ghost" onClick={() => onNavigate({ name: 'items' })}>
              Have a look
            </Button>
          </div>
        )}
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
                label="Item name"
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
            <div className="w-40">
              <Select
                label="Category"
                value={category}
                disabled={creating}
                onChange={(event) => setCategory(event.target.value as ItemCategory)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              type="submit"
              variant="primary"
              loading={creating}
              loadingLabel="Creating item"
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
            aria-label="Loading items"
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
            description="Create an item, then tell the coach what you're avoiding."
            action={
              !showCreate ? (
                <Button variant="primary" onClick={() => setShowCreate(true)}>
                  New item
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {groupByCategory(projects.filter((p) => p.status !== 'archived')).map((group) => (
              <section
                key={group.category}
                aria-labelledby={`library-${group.category.toLowerCase()}`}
                data-category={group.category}
                className="space-y-4"
              >
                <h2
                  id={`library-${group.category.toLowerCase()}`}
                  className="text-lg font-bold tracking-[-0.01em] text-fg-1"
                >
                  {group.category}
                </h2>
                {group.items.length === 0 ? (
                  <p className="text-sm text-fg-3">Nothing here yet.</p>
                ) : (
                  renderGrid(group.items)
                )}
              </section>
            ))}
            {archived.length > 0 && (
              <section aria-label="Archived items" className="space-y-4">
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={ChevronRight}
                  aria-expanded={showArchived}
                  aria-controls="library-archived"
                  className={
                    showArchived
                      ? '[&_svg]:rotate-90 [&_svg]:transition-transform'
                      : '[&_svg]:transition-transform'
                  }
                  onClick={() => setShowArchived((v) => !v)}
                >
                  Archived ({archived.length})
                </Button>
                <div id="library-archived" hidden={!showArchived}>
                  {renderGrid(archived)}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
