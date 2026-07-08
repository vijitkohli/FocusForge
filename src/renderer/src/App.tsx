import React, { useState, useEffect } from 'react'
import { Dashboard } from './components/Dashboard'
import { ProjectWorkspace } from './components/ProjectWorkspace'
import { FocusMode, FocusScope } from './components/FocusMode'
import { UserProfile } from './components/UserProfile'

type ActiveView = 'home' | 'profile'

function App() {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [focus, setFocus] = useState<FocusScope | null>(null)
  const [activeView, setActiveView] = useState<ActiveView>('home')

  // Clicking a procrastination nudge notification jumps straight into Start Now.
  useEffect(() => window.api.onOpenFocus(() => setFocus({ scope: 'global' })), [])

  const openProject = (id: string, taskId?: string): void => {
    setActiveProjectId(id)
    setActiveTaskId(taskId ?? null)
    setFocus(null)
    setActiveView('home')
  }

  const goHome = (): void => {
    setActiveProjectId(null)
    setActiveTaskId(null)
    setFocus(null)
    setActiveView('home')
  }

  // Focus mode is intentionally full-screen / distraction-free — no rail.
  if (focus) {
    return (
      <div className="flex h-full w-full text-fg-1">
        <FocusMode focus={focus} onExit={() => setFocus(null)} onOpenProject={openProject} />
      </div>
    )
  }

  function renderPage() {
    if (activeView === 'profile') return <UserProfile />
    if (activeProjectId) {
      return (
        <ProjectWorkspace
          projectId={activeProjectId}
          initialTaskId={activeTaskId ?? undefined}
          onBack={goHome}
          onStartFocus={(taskId) =>
            setFocus({ scope: 'task', projectId: activeProjectId, taskId })
          }
        />
      )
    }
    return <Dashboard onOpenProject={openProject} onStartNow={() => setFocus({ scope: 'global' })} />
  }

  return (
    <div className="flex h-full w-full gap-0 text-fg-1">
      {/* FLOATING FROSTED RAIL */}
      <nav className="flex shrink-0 flex-col items-center gap-2 px-3 py-4">
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-linear-to-br from-accent to-accent-hover text-sm font-bold text-white shadow-lg">
          F
        </div>
        <RailButton label="Home" active={activeView === 'home' && !activeProjectId} onClick={goHome}>
          ⌂
        </RailButton>
        <RailButton label="Start Now" active={false} onClick={() => setFocus({ scope: 'global' })}>
          ▶
        </RailButton>
        {/* Spacer pushes Profile to the bottom of the rail */}
        <div className="flex-1" />
        <RailButton
          label="Profile"
          active={activeView === 'profile'}
          onClick={() => { setActiveProjectId(null); setActiveTaskId(null); setActiveView('profile') }}
        >
          ◉
        </RailButton>
      </nav>

      {/* FLOATING PAGE */}
      <main className="flex min-w-0 flex-1 py-3 pr-3">
        <div className="glass-strong flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl">
          {renderPage()}
        </div>
      </main>
    </div>
  )
}

function RailButton({
  label,
  active,
  onClick,
  children
}: {
  label: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex h-11 w-11 items-center justify-center rounded-lg text-lg transition ${
        active
          ? 'bg-accent-soft text-accent'
          : 'text-fg-2 hover:bg-surface hover:text-fg-1'
      }`}
    >
      {children}
    </button>
  )
}

export default App
