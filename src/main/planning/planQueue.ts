// src/main/planning/planQueue.ts
//
// Rolling expansion in the background (PHASE5 §3.4): one planning call at a
// time, de-duplicated, re-checked against fresh data before it runs, and
// paused silently while the AI proxy is down. Every project save is fed in
// through onProjectSaved(); deterministic `advance` steps are applied at once
// (no model call), everything else is queued. Electron-free; the main process
// wires the deps.

import type { ProjectData, ProjectTask } from '../../common/types'
import type { PlanStatusEvent, PlanTaskResult } from '../../common/milestones'
import { applyAdvance, nextPlanAction, stepsOf } from '../../common/milestones'
import { isUnplanned } from '../../common/outline'
import type { PlanMode } from './planner'

/** The shared proxy health (Phase 3's src/main/proxyHealth.ts provides the real one). */
export interface ProxyHealthLike {
  isUp(): boolean | Promise<boolean>
  onChange(cb: (up: boolean) => void): () => void
}

export interface PlanJob {
  projectId: string
  taskId: string
  kind: PlanMode
  milestoneId?: string
  /** Step count when queued: part of the de-dupe key, so a changed task can queue again. */
  stepCount: number
}

export interface PlanQueueDeps {
  health: ProxyHealthLike
  loadProjectData(projectId: string): Promise<ProjectData | null>
  /** Is this item active (background work only runs for active items)? */
  isActive(projectId: string): boolean
  run(job: PlanJob): Promise<PlanTaskResult>
  /** Applies a deterministic milestone advance under the project lock. */
  advance(projectId: string, taskId: string, from: string): Promise<void>
  notify(event: PlanStatusEvent): void
  tasksChanged(): void
  /** Auto-plan new unplanned auto-created tasks (D8, default on). */
  autoPlan?(): boolean
  retryMs?: number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

export type PlanQueueState = 'idle' | 'running' | 'paused'

export interface PlanQueueStatus {
  state: PlanQueueState
  queued: number
  current: string | null
}

export function jobKey(job: PlanJob): string {
  return `${job.projectId}:${job.taskId}:${job.kind}:${job.milestoneId ?? ''}:${job.stepCount}`
}

/** What background work a task needs right now, or null. */
export function jobFor(
  projectId: string,
  task: ProjectTask,
  autoPlan: boolean
): PlanJob | { advance: string } | null {
  const stepCount = (task.subtasks ?? []).length
  if (isUnplanned(task)) {
    return autoPlan && task.origin ? { projectId, taskId: task.id, kind: 'plan', stepCount } : null
  }
  const action = nextPlanAction(task)
  switch (action.kind) {
    case 'advance':
      return { advance: action.from }
    case 'prefetch':
    case 'continue':
    case 'expand':
      return {
        projectId,
        taskId: task.id,
        kind: 'expand',
        milestoneId: action.milestoneId,
        stepCount
      }
    default:
      return null
  }
}

export class PlanQueue {
  private queue: PlanJob[] = []
  private keys = new Set<string>()
  /** Jobs that ran (or failed/asked) this session; never auto-retried for the same task state. */
  private attempted = new Set<string>()
  private running: PlanJob | null = null
  private paused = false
  private unsubscribe: (() => void) | null = null
  private timer: unknown = null

  constructor(private deps: PlanQueueDeps) {}

  status(): PlanQueueStatus {
    return {
      state: this.running ? 'running' : this.paused ? 'paused' : 'idle',
      queued: this.queue.length,
      current: this.running ? jobKey(this.running) : null
    }
  }

  /** Queues a job unless an identical one is queued, running or already tried. */
  enqueue(job: PlanJob): boolean {
    const key = jobKey(job)
    if (this.keys.has(key) || this.attempted.has(key)) return false
    this.keys.add(key)
    this.queue.push(job)
    this.deps.notify({ projectId: job.projectId, taskId: job.taskId, state: 'queued' })
    void this.pump()
    return true
  }

  /** Save hook: advances milestones and queues the next batches. */
  async onProjectSaved(projectId: string, data: ProjectData): Promise<void> {
    if (!this.deps.isActive(projectId)) return
    const auto = this.deps.autoPlan ? this.deps.autoPlan() : true
    for (const task of data.tasks ?? []) {
      const next = jobFor(projectId, task, auto)
      if (!next) continue
      if ('advance' in next) {
        try {
          await this.deps.advance(projectId, task.id, next.advance)
          this.deps.tasksChanged()
        } catch (err) {
          console.error('Milestone advance failed', err)
        }
      } else {
        this.enqueue(next)
      }
    }
  }

  /** Startup scan of the given items. */
  async scan(projectIds: string[]): Promise<void> {
    for (const id of projectIds) {
      const data = await this.deps.loadProjectData(id)
      if (data) await this.onProjectSaved(id, data)
    }
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.timer && this.deps.clearTimer) this.deps.clearTimer(this.timer)
    this.timer = null
    this.queue = []
    this.keys.clear()
  }

  private stillNeeded(job: PlanJob, data: ProjectData | null): boolean {
    const task = data?.tasks.find((t) => t.id === job.taskId)
    if (!task) return false
    const now = jobFor(job.projectId, task, true)
    if (!now || 'advance' in now) return false
    if (now.kind !== job.kind || now.milestoneId !== job.milestoneId) return false
    if (job.kind === 'expand' && job.milestoneId) {
      return !stepsOf(task, job.milestoneId).some((s) => !s.isCompleted)
    }
    return true
  }

  private pauseUntilUp(): void {
    if (this.paused) return
    this.paused = true
    this.unsubscribe = this.deps.health.onChange((up) => {
      if (up) this.resume()
    })
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    this.timer = set(() => this.resume(), this.deps.retryMs ?? 5 * 60_000)
  }

  private resume(): void {
    if (!this.paused) return
    this.paused = false
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.timer && this.deps.clearTimer) this.deps.clearTimer(this.timer)
    this.timer = null
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.running || this.paused) return
    const job = this.queue.shift()
    if (!job) return
    this.running = job
    const key = jobKey(job)
    try {
      if (!(await this.deps.health.isUp())) {
        // Put it back and wait quietly: no error pop-ups while the proxy is down.
        this.queue.unshift(job)
        this.running = null
        this.pauseUntilUp()
        return
      }
      const fresh = await this.deps.loadProjectData(job.projectId)
      if (!this.stillNeeded(job, fresh)) {
        this.keys.delete(key)
        return
      }
      this.attempted.add(key)
      this.deps.notify({ projectId: job.projectId, taskId: job.taskId, state: 'running' })
      const result = await this.deps.run(job)
      const ok = result.success
      this.deps.notify({
        projectId: job.projectId,
        taskId: job.taskId,
        state: ok ? 'done' : 'failed',
        ...(ok ? {} : { message: result.message })
      })
      if (ok) this.deps.tasksChanged()
      this.keys.delete(key)
    } catch (err) {
      console.error('Background planning failed', err)
      this.deps.notify({ projectId: job.projectId, taskId: job.taskId, state: 'failed' })
      this.keys.delete(key)
    } finally {
      if (this.running === job) this.running = null
      void this.pump()
    }
  }
}

/**
 * Minimal proxy check used until Phase 3's ProxyHealth is merged: any HTTP
 * reply from the models endpoint (even 401) means up; refused/timeout = down.
 */
export class FetchProxyHealth implements ProxyHealthLike {
  private listeners: ((up: boolean) => void)[] = []
  private last: boolean | null = null
  private checkedAt = 0

  constructor(
    private url = process.env.FOCUSFORGE_PROXY_URL ?? 'http://localhost:8317/v1/models',
    private ttlMs = 60_000
  ) {}

  async isUp(): Promise<boolean> {
    if (this.last !== null && Date.now() - this.checkedAt < this.ttlMs) return this.last
    let up = false
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 3000)
      await fetch(this.url, { signal: ctrl.signal })
      clearTimeout(t)
      up = true
    } catch {
      up = false
    }
    this.checkedAt = Date.now()
    if (up !== this.last) {
      this.last = up
      for (const l of [...this.listeners]) l(up)
    }
    return up
  }

  onChange(cb: (up: boolean) => void): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb)
    }
  }
}

/** applyAdvance under the project lock, only if the milestone is still current. */
export function advanceTask(task: ProjectTask, from: string): ProjectTask | null {
  const action = nextPlanAction(task)
  if (action.kind !== 'advance' || action.from !== from) return null
  return applyAdvance(task)
}
