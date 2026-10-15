import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { NowPlaying } from './views/NowPlaying'
import { Library } from './views/Library'
import { Project } from './views/Project'
import { Coach } from './views/Coach'
import { History } from './views/History'
import { TaskPage } from './views/task/TaskPage'
import { FocusMode } from './components/FocusMode'
import { UserProfile } from './components/UserProfile'
import { queueStore } from './lib/queue'
import { MiniPlayer } from './shell/MiniPlayer'
import { Sidebar } from './shell/Sidebar'
import type { FocusScope, NavigationProps, View } from './shell/navigation'

function App(): JSX.Element {
  const [view, setView] = useState<View>({ name: 'now' })
  const previousPage = useRef<View>({ name: 'now' })

  const navigate = useCallback(
    (next: View): void => {
      if (next.name === 'focus' && view.name !== 'focus') previousPage.current = view
      setView(next)
    },
    [view]
  )

  const openProject = useCallback(
    (projectId: string, taskId?: string): void => {
      navigate(
        taskId === undefined ? { name: 'project', projectId } : { name: 'task', projectId, taskId }
      )
    },
    [navigate]
  )

  const openFocus = useCallback(
    (scope: FocusScope = { scope: 'global' }): void => {
      navigate({ name: 'focus', scope })
    },
    [navigate]
  )

  const globalFocus = useCallback((): void => openFocus(), [openFocus])
  const exitFocus = useCallback((): void => navigate(previousPage.current), [navigate])
  const navigation: NavigationProps = {
    onNavigate: navigate,
    onOpenProject: openProject,
    onOpenFocus: openFocus
  }

  useEffect(() => window.api.onOpenFocus(globalFocus), [globalFocus])
  useEffect(() => window.api.onOpenHistory(() => navigate({ name: 'history' })), [navigate])
  useEffect(() => window.api.onTasksChanged(() => void queueStore.refresh().catch(() => {})), [])

  useEffect(() => {
    // Read fresh disk state on navigation, including changes from notification actions.
    void queueStore.refresh().catch((error: unknown) => {
      console.error('Failed to refresh queue on navigation', error)
    })
  }, [view])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      // Dialogs own their keyboard handling, including when focus is in a portal.
      if (
        document.querySelector(
          'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'
        )
      )
        return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('[role="menu"], [role="listbox"]')) return

      // Command navigation is safe in fields; unmodified editing keys are not.
      if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const destinations: Record<string, View> = {
          '1': { name: 'now' },
          '2': { name: 'library' },
          '3': { name: 'history' },
          ',': { name: 'profile' }
        }
        const destination = destinations[event.key]
        if (destination) {
          event.preventDefault()
          navigate(destination)
        }
        return
      }
      if (
        target?.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
        )
      )
        return
      if (
        event.key === 'Escape' &&
        view.name === 'focus' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault()
        exitFocus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, navigate, exitFocus])

  function renderPage(): JSX.Element {
    switch (view.name) {
      case 'profile':
        return <UserProfile />
      case 'project':
        return <Project key={view.projectId} projectId={view.projectId} {...navigation} />
      case 'coach':
        return (
          <Coach
            key={`${view.projectId}:${view.planTaskId ?? ''}`}
            projectId={view.projectId}
            planTaskId={view.planTaskId}
            {...navigation}
          />
        )
      case 'task':
        return <TaskPage projectId={view.projectId} taskId={view.taskId} {...navigation} />
      case 'now':
        return <NowPlaying {...navigation} />
      case 'library':
        return <Library {...navigation} />
      case 'history':
        return <History {...navigation} />
      case 'focus':
        return (
          <FocusMode
            focus={view.scope}
            onExit={exitFocus}
            onOpenProject={navigation.onOpenProject}
          />
        )
    }
  }

  if (view.name === 'focus') {
    return <main className="h-full w-full overflow-y-auto bg-bg-1 text-fg-1">{renderPage()}</main>
  }

  return (
    <div className="flex h-full w-full bg-bg-1 text-fg-1">
      <Sidebar view={view} onNavigate={navigate} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div
            className={`mx-auto flex w-full max-w-[1424px] flex-col px-8 ${view.name === 'now' ? 'py-6' : 'py-8'} ${view.name === 'coach' ? 'h-full min-h-0' : 'min-h-full'}`}
          >
            {renderPage()}
          </div>
        </main>
        {view.name !== 'now' && (
          <MiniPlayer
            onOpenFocus={globalFocus}
            onOpenLibrary={() => navigate({ name: 'library' })}
          />
        )}
      </div>
    </div>
  )
}

export default App
