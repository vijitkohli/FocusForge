import { useEffect, useState, type JSX, type ReactNode } from 'react'
import {
  Disc3,
  LibraryBig,
  CalendarDays,
  PanelLeftClose,
  PanelLeftOpen,
  CircleUser
} from 'lucide-react'
import { Cover, IconButton } from '../ui'
import type { NavigationProps, View } from './navigation'

const COLLAPSED_KEY = 'focusforge.sidebar.collapsed'
const NARROW_QUERY = '(max-width: 1099px)'

interface ProjectSummary {
  id: string
  name: string
}

export interface SidebarProps extends Pick<NavigationProps, 'onNavigate'> {
  view: View
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

export function Sidebar({ view, onNavigate }: SidebarProps): JSX.Element {
  const [preferredCollapsed, setPreferredCollapsed] = useState(readCollapsed)
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loadedView, setLoadedView] = useState<View | null>(null)
  const [error, setError] = useState(false)
  const loading = loadedView !== view
  const collapsed = narrow || preferredCollapsed

  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY)
    const update = (): void => setNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, String(preferredCollapsed))
    } catch {
      // Navigation still works when storage is unavailable.
    }
  }, [preferredCollapsed])

  useEffect(() => {
    let cancelled = false
    let request = 0
    const refresh = (): void => {
      const version = ++request
      void window.api.getProjects().then(
        (list: ProjectSummary[]) => {
          if (!cancelled && version === request) {
            setProjects(list)
            setError(false)
            setLoadedView(view)
          }
        },
        (reason: unknown) => {
          if (!cancelled && version === request) {
            setError(true)
            setLoadedView(view)
            console.error('Failed to refresh sidebar projects', reason)
          }
        }
      )
    }
    window.addEventListener('focusforge:projects-changed', refresh)
    refresh()
    return () => {
      cancelled = true
      window.removeEventListener('focusforge:projects-changed', refresh)
    }
  }, [view])

  const activeProjectId =
    view.name === 'project' || view.name === 'coach' || view.name === 'task' ? view.projectId : null

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-r border-line bg-bg-0"
      style={{ width: collapsed ? 64 : 232 }}
    >
      <header
        className={`flex h-20 shrink-0 items-center ${collapsed ? 'justify-center' : 'gap-2 px-5'}`}
      >
        {collapsed ? (
          <span className="sr-only">FocusForge</span>
        ) : (
          <span className="flex-1 text-[17px] font-bold tracking-[-0.02em]">FocusForge</span>
        )}
        <IconButton
          label={
            narrow
              ? 'Sidebar collapses below 1100px'
              : collapsed
                ? 'Expand sidebar'
                : 'Collapse sidebar'
          }
          icon={collapsed ? PanelLeftOpen : PanelLeftClose}
          disabled={narrow}
          aria-expanded={!collapsed}
          onClick={() => setPreferredCollapsed(!preferredCollapsed)}
        />
      </header>

      <nav aria-label="Main navigation" className="space-y-1 px-2">
        <SidebarItem
          label="Now"
          shortcut="⌘1"
          collapsed={collapsed}
          active={view.name === 'now'}
          onClick={() => onNavigate({ name: 'now' })}
          icon={<Disc3 size={20} />}
        />
        <SidebarItem
          label="Library"
          shortcut="⌘2"
          collapsed={collapsed}
          active={view.name === 'library'}
          onClick={() => onNavigate({ name: 'library' })}
          icon={<LibraryBig size={20} />}
        />
        <SidebarItem
          label="History"
          shortcut="⌘3"
          collapsed={collapsed}
          active={view.name === 'history'}
          onClick={() => onNavigate({ name: 'history' })}
          icon={<CalendarDays size={20} />}
        />
      </nav>

      <nav
        aria-label="Projects"
        aria-busy={loading}
        className="mt-8 min-h-0 flex-1 overflow-y-auto px-2"
      >
        <h2 className={collapsed ? 'sr-only' : 'mb-2 px-3 text-xs font-medium text-fg-3'}>
          Projects
        </h2>
        {error && !loading && (
          <p role="status" className={collapsed ? 'sr-only' : 'px-3 py-2 text-xs text-fg-3'}>
            Could not load projects. Open Library to retry.
          </p>
        )}
        <div className="space-y-1">
          {projects.slice(0, 8).map((project) => (
            <SidebarItem
              key={project.id}
              label={project.name}
              collapsed={collapsed}
              active={activeProjectId === project.id}
              onClick={() => onNavigate({ name: 'project', projectId: project.id })}
              icon={<Cover projectId={project.id} name={project.name} size={24} decorative />}
            />
          ))}
          <SidebarItem
            label="See all"
            collapsed={collapsed}
            active={false}
            onClick={() => onNavigate({ name: 'library' })}
            icon={<LibraryBig size={20} />}
          />
        </div>
      </nav>

      <nav aria-label="Account" className="shrink-0 px-2 py-4">
        <SidebarItem
          label="Profile"
          shortcut="⌘,"
          collapsed={collapsed}
          active={view.name === 'profile'}
          onClick={() => onNavigate({ name: 'profile' })}
          icon={<CircleUser size={20} />}
        />
      </nav>
    </aside>
  )
}

function SidebarItem({
  label,
  shortcut,
  collapsed,
  active,
  onClick,
  icon
}: {
  label: string
  shortcut?: string
  collapsed: boolean
  active: boolean
  onClick: () => void
  icon: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      aria-keyshortcuts={shortcut ? `Meta+${shortcut.slice(1)}` : undefined}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={`relative flex h-11 w-full items-center rounded-md text-sm hover:bg-bg-2 hover:text-fg-1 ${
        collapsed ? 'justify-center' : 'gap-3 px-3'
      } ${active ? 'text-fg-1' : 'text-fg-2'}`}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute left-0 h-[3px] w-[3px] rounded-full bg-accent"
        />
      )}
      <span className="flex w-6 shrink-0 items-center justify-center">{icon}</span>
      <span className={collapsed ? 'sr-only' : 'truncate'}>{label}</span>
    </button>
  )
}
