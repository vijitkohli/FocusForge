// src/main/itemTasks.ts
//
// syncItemTasks(projectId): digest -> deliverable/goal tasks, saved under the
// project lock. Runs on Phase 3's digest-updated event and on the manual
// "sync-item-tasks" IPC. New tasks are then auto-planned by the PlanQueue
// through the shared save hook.

import type { ProjectData, Workstream } from '../common/types'
import type { ProjectMutation } from './store/ProjectStore'
import type { PackSource } from './planning/packSource'
import { tasksFromDigest } from '../common/itemTasks'
import { localDateKey } from '../common/schedule'

export interface ItemTaskDeps {
  getProject(projectId: string): Workstream | undefined
  packSource: PackSource
  updateProjectData(
    projectId: string,
    mutate: (data: ProjectData) => Promise<ProjectMutation>
  ): Promise<{ success: boolean; error?: string } | null>
  newId(): string
  today?(): string
}

export async function syncItemTasks(
  deps: ItemTaskDeps,
  projectId: string
): Promise<{ added: number; updated: number; error?: string }> {
  const item = deps.getProject(projectId)
  if (!item) return { added: 0, updated: 0, error: 'Item not found.' }
  if (item.status !== 'active') return { added: 0, updated: 0 }
  const bundle = await deps.packSource.getContextPack(projectId)
  const digest = bundle?.digest
  if (!digest) return { added: 0, updated: 0 }
  let added = 0
  let updated = 0
  const today = deps.today ? deps.today() : localDateKey(new Date())
  const saved = await deps.updateProjectData(projectId, async (file) => {
    const { add, update } = tasksFromDigest(
      digest,
      item,
      file.tasks ?? [],
      file.dismissedOrigins ?? [],
      today,
      deps.newId
    )
    if (add.length === 0 && update.length === 0) return null
    added = add.length
    updated = update.length
    const tasks = (file.tasks ?? []).map((t) => {
      const u = update.find((x) => x.taskId === t.id)
      return u ? { ...t, ...u.patch } : t
    })
    return {
      data: { ...file, tasks: [...tasks, ...add] },
      notes: [
        ...add.map((t) => ({
          section: 'Plan Adjustments' as const,
          note: `Added "${t.title}" from the item's sources${t.deadlineKind === 'none' ? '' : ` (due ${t.deadline}${t.deadlineKind === 'tentative' ? ', tentative' : ''})`}.`
        })),
        ...update.map((u) => ({
          section: 'Plan Adjustments' as const,
          note: `Due date for "${tasks.find((t) => t.id === u.taskId)?.title}" is now ${u.patch.deadline}.`
        }))
      ]
    }
  })
  if (saved && !saved.success) return { added: 0, updated: 0, error: saved.error }
  return { added, updated }
}
