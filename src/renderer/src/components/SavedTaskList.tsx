import React from 'react'
import { ProjectTask } from 'src/common/types'

interface SavedTaskListProps {
  tasks: ProjectTask[]
  onView: (task: ProjectTask) => void
  onDelete: (e: React.MouseEvent, task: ProjectTask) => void
}

/** The project's previously generated tasks, newest first. */
export function SavedTaskList({
  tasks,
  onView,
  onDelete
}: SavedTaskListProps): React.JSX.Element | null {
  if (tasks.length === 0) return null

  return (
    <div className="shrink-0 border-t border-border py-4">
      <h3 className="mb-3 text-sm font-medium text-fg-2">Saved Tasks</h3>
      <div className="flex max-h-48 flex-col gap-2 overflow-y-auto pr-1">
        {[...tasks].reverse().map((task) => (
          <div
            key={task.id}
            className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3"
          >
            <div className="min-w-0">
              <p className="text-xs text-fg-3">
                Created {new Date(task.createdAt).toLocaleDateString()}
              </p>
              <p className="truncate font-medium">{task.title}</p>
              <p className="text-xs text-fg-2">
                {task.subtasks.length} sub-steps • {task.status}
              </p>
            </div>
            <div className="ml-3 flex shrink-0 gap-2">
              <button
                onClick={() => onView(task)}
                className="rounded-md bg-bg-3 px-3 py-1.5 text-xs text-fg-1 transition hover:bg-accent hover:text-white"
              >
                View
              </button>
              <button
                title="Delete this task"
                onClick={(e) => onDelete(e, task)}
                className="rounded-md bg-bg-3 px-3 py-1.5 text-xs text-hard transition hover:bg-hard/15"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
