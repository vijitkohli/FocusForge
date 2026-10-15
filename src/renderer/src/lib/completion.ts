import { flushSync } from 'react-dom'
import { withCompletion, type UpcomingSubtask } from '../../../common/types'
import { queueStore } from './queue'
import { updateTask } from './updateTask'

export interface CompletionOptions {
  /** Parent state changes (session count, scoped next step, timer) join the queue transition. */
  onCompleted?: () => void | Promise<void>
}

export async function completeSubtask(
  item: UpcomingSubtask,
  options: CompletionOptions = {}
): Promise<void> {
  await updateTask(
    item.projectId,
    item.taskId,
    (task) => {
      if (!task.subtasks.some((step) => step.id === item.subtaskId)) {
        throw new Error('This step no longer exists. Reload the queue to choose another step.')
      }
      return {
        ...task,
        subtasks: task.subtasks.map((step) =>
          step.id === item.subtaskId ? withCompletion(step, true) : step
        )
      }
    },
    {
      section: 'Milestones & Completed Work',
      note: `Completed "${item.subtaskTitle}" from Start Now.`
    }
  )

  const advance = async (): Promise<void> => {
    await queueStore.refresh()
    let completed: void | Promise<void> = undefined
    flushSync(() => {
      completed = options.onCompleted?.()
    })
    await completed
  }
  if (
    typeof document === 'undefined' ||
    typeof document.startViewTransition !== 'function' ||
    (typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  ) {
    await advance()
    return
  }

  const finishedTitle = document.querySelector?.<HTMLElement>(
    '[style*="view-transition-name: now-title"]'
  )
  const firstQueuedTitle = document.querySelector?.<HTMLElement>(
    '[style*="view-transition-name: queue-0"]'
  )
  if (finishedTitle) finishedTitle.style.viewTransitionName = 'completed-title'
  if (firstQueuedTitle) firstQueuedTitle.style.viewTransitionName = 'now-title'

  const restoreNames = (): void => {
    if (firstQueuedTitle?.style.viewTransitionName === 'now-title') {
      firstQueuedTitle.style.viewTransitionName = 'queue-0'
    }
    if (finishedTitle?.style.viewTransitionName === 'completed-title') {
      finishedTitle.style.viewTransitionName = 'now-title'
    }
  }
  let update: Promise<void> | undefined
  const updateView = (): Promise<void> => {
    update ??= (async () => {
      try {
        await advance()
        flushSync(() => {})
      } finally {
        restoreNames()
      }
    })()
    return update
  }

  let transition: ViewTransition
  try {
    transition = document.startViewTransition(updateView)
  } catch {
    restoreNames()
    await (update ?? advance())
    return
  }
  void transition.ready.catch(() => {})
  void transition.finished?.catch(() => {})
  try {
    await transition.updateCallbackDone
  } finally {
    restoreNames()
  }
}
