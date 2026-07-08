// src/renderer/src/components/Dashboard.tsx
import { useState, useEffect } from 'react'
import { UpcomingSubtask } from 'src/common/types'
import { Momentum } from './Momentum'

type Mood = 'lazy' | 'normal' | 'motivated'

const MOOD_TO_DIFFICULTY: Record<Mood, UpcomingSubtask['difficulty']> = {
  lazy: 'easy',
  normal: 'medium',
  motivated: 'hard'
}

const MAX_SUGGESTIONS = 5

interface ProjectSummary {
  id: string
  name: string
  path: string
  progress: number
  lastActive: string
}

interface DashboardProps {
  onOpenProject: (projectId: string, taskId?: string) => void
  onStartNow: () => void
}

// < 3 days: red, 3-7 days: amber, > 7 days: green. Overdue counts as red too.
function urgencyBorder(daysRemaining: number): string {
  if (daysRemaining < 3) return 'border-l-hard'
  if (daysRemaining <= 7) return 'border-l-medium'
  return 'border-l-easy'
}

function formatDaysRemaining(daysRemaining: number): string {
  if (daysRemaining < 0) return `${Math.abs(daysRemaining)}d overdue`
  if (daysRemaining === 0) return 'Due today'
  if (daysRemaining === 1) return 'Due tomorrow'
  return `${daysRemaining}d left`
}

const MOODS: { value: Mood; emoji: string; label: string }[] = [
  { value: 'lazy', emoji: '🛋️', label: 'Lazy' },
  { value: 'normal', emoji: '🙂', label: 'Normal' },
  { value: 'motivated', emoji: '🔥', label: 'Motivated' }
]

export function Dashboard({ onOpenProject, onStartNow }: DashboardProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [newProjectName, setNewProjectName] = useState('')
  const [loading, setLoading] = useState(true)

  // --- MOOD SUGGESTIONS STATE ---
  const [upcomingSubtasks, setUpcomingSubtasks] = useState<UpcomingSubtask[]>([])
  const [mood, setMood] = useState<Mood | ''>('')

  // 1. LOAD PROJECTS
  useEffect(() => {
    loadProjects()
    loadUpcomingSubtasks()
  }, [])

  const loadProjects = async () => {
    try {
      const list = await window.api.getProjects()
      setProjects(list)
    } catch (e) {
      console.error('Failed to load projects', e)
    } finally {
      setLoading(false)
    }
  }

  const loadUpcomingSubtasks = async () => {
    try {
      const subtasks = await window.api.getUpcomingSubtasks()
      setUpcomingSubtasks(subtasks)
    } catch (e) {
      console.error('Failed to load upcoming subtasks', e)
    }
  }

  // 2.5 DELETE PROJECT
  const handleDeleteProject = async (e: React.MouseEvent, projectId: string, projectName: string) => {
    e.stopPropagation()
    if (!window.confirm(`Delete "${projectName}"? This removes all its tasks and context permanently.`)) return

    try {
      await window.api.deleteProject(projectId)
      setProjects((prev) => prev.filter((p) => p.id !== projectId))
      setUpcomingSubtasks((prev) => prev.filter((s) => s.projectId !== projectId))
    } catch (e) {
      console.error('Failed to delete project', e)
    }
  }

  // 2. CREATE PROJECT
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newProjectName.trim()) return

    try {
      const newProject = await window.api.createProject(newProjectName)
      setProjects([...projects, newProject])
      setNewProjectName('')
    } catch (e) {
      console.error('Failed to create', e)
    }
  }

  const difficulty = mood ? MOOD_TO_DIFFICULTY[mood] : null
  const moodMatches = difficulty
    ? upcomingSubtasks.filter((s) => s.difficulty === difficulty).slice(0, MAX_SUGGESTIONS)
    : []

  return (
    <div className="flex h-full w-full justify-center overflow-y-auto">
      <div className="flex min-h-full w-full max-w-3xl flex-col gap-8 px-8 py-10">
      {/* HEADER */}
      <header className="flex items-end justify-between gap-6">
        <div>
          <h1 className="text-4xl font-semibold tracking-tight">Your Projects</h1>
          <p className="mt-1 text-fg-2">Pick a workspace and ease into flow state.</p>
        </div>

        <form onSubmit={handleCreate} className="flex shrink-0 gap-2">
          <input
            type="text"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            placeholder="New project…"
            className="w-44 rounded-md border border-border bg-surface px-4 py-2.5 text-sm text-fg-1 placeholder:text-fg-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          <button
            type="submit"
            className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
            disabled={!newProjectName.trim()}
          >
            + New
          </button>
        </form>
      </header>

      {/* START NOW */}
      <section>
        <button
          onClick={onStartNow}
          disabled={upcomingSubtasks.length === 0}
          className="group flex w-full items-center justify-between gap-4 rounded-xl bg-linear-to-br from-accent to-accent-hover px-6 py-5 text-left text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <div className="min-w-0">
            <p className="text-lg font-semibold">▶ Start Now</p>
            <p className="mt-0.5 truncate text-sm text-white/80">
              {upcomingSubtasks.length === 0
                ? 'Nothing queued — add a task to get going.'
                : `Next: ${upcomingSubtasks[0].subtaskTitle}`}
            </p>
          </div>
          <span className="shrink-0 text-2xl transition group-hover:translate-x-1">→</span>
        </button>
      </section>

      {/* MOMENTUM (streaks + heatmap) */}
      <Momentum />

      {/* MOOD */}
      <section className="rounded-2xl glass p-5">
        <h2 className="text-sm font-medium text-fg-2">How are you feeling today?</h2>
        <div className="mt-3 flex gap-2">
          {MOODS.map((m) => (
            <button
              key={m.value}
              onClick={() => setMood(mood === m.value ? '' : m.value)}
              className={`flex-1 rounded-xl border px-4 py-3 text-sm font-medium transition ${
                mood === m.value
                  ? 'border-accent bg-accent-soft text-fg-1'
                  : 'border-border bg-surface text-fg-2 hover:border-border-strong hover:text-fg-1'
              }`}
            >
              <span className="mr-2">{m.emoji}</span>
              {m.label}
            </button>
          ))}
        </div>

        {mood && (
          <div className="mt-4">
            {moodMatches.length === 0 ? (
              <p className="py-4 text-center text-sm text-fg-3">No {difficulty} tasks right now — nice work.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {moodMatches.map((s) => (
                  <button
                    key={s.subtaskId}
                    onClick={() => onOpenProject(s.projectId, s.taskId)}
                    className={`flex items-center justify-between rounded-r-lg border-l-4 bg-bg-3 px-4 py-3 text-left transition hover:bg-bg-3/70 ${urgencyBorder(s.daysRemaining)}`}
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{s.subtaskTitle}</p>
                      <p className="truncate text-xs text-fg-2">
                        {s.projectName} • {s.taskTitle}
                      </p>
                    </div>
                    <span className="ml-3 shrink-0 rounded-md bg-bg-1 px-2.5 py-1 text-xs text-fg-2">
                      {formatDaysRemaining(s.daysRemaining)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* DEADLINES */}
      <section>
        <h2 className="mb-3 text-xl font-semibold">Deadlines</h2>
        {upcomingSubtasks.length === 0 ? (
          <div className="rounded-2xl glass py-8 text-center text-sm text-fg-3">
            No upcoming tasks yet.
          </div>
        ) : (
          <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
            {upcomingSubtasks.map((s) => (
              <button
                key={s.subtaskId}
                onClick={() => onOpenProject(s.projectId, s.taskId)}
                className={`flex items-center justify-between rounded-r-lg border-l-4 bg-bg-2 px-4 py-3.5 text-left transition hover:bg-bg-3 ${urgencyBorder(s.daysRemaining)}`}
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{s.subtaskTitle}</p>
                  <p className="truncate text-xs text-fg-2">
                    {s.projectName} • {s.taskTitle} • Due{' '}
                    {new Date(s.deadline).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <span className="ml-3 shrink-0 rounded-md bg-bg-1 px-2.5 py-1 text-xs text-fg-2">
                  {formatDaysRemaining(s.daysRemaining)}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* PROJECT GRID */}
      <section className="pb-4">
        {loading ? (
          <div className="py-12 text-center text-fg-3">Loading…</div>
        ) : projects.length === 0 ? (
          <div className="rounded-2xl glass py-12 text-center">
            <h3 className="font-medium">No projects yet</h3>
            <p className="mt-1 text-sm text-fg-3">Create your first project above to get started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {projects.map((project) => (
              <div
                key={project.id}
                onClick={() => onOpenProject(project.id)}
                className="group flex cursor-pointer flex-col justify-between rounded-2xl glass p-5 transition hover:-translate-y-0.5 hover:border-accent/40 hover:bg-bg-3"
              >
                <div className="mb-4 flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-linear-to-br from-accent to-accent-hover text-sm font-semibold text-white">
                    {project.name.substring(0, 2).toUpperCase()}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-fg-3">
                      {new Date(project.lastActive).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                    <button
                      title="Delete project"
                      onClick={(e) => handleDeleteProject(e, project.id, project.name)}
                      className="rounded p-1 text-fg-3 opacity-0 transition hover:bg-hard/10 hover:text-hard group-hover:opacity-100"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div>
                  <h3 className="mb-2 text-lg font-medium">{project.name}</h3>
                  <div className="h-1.5 overflow-hidden rounded-full bg-bg-1">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${project.progress}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      </div>
    </div>
  )
}
