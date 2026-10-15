import type { FocusScope } from '../components/FocusMode'

export type { FocusScope }

export type View =
  | { name: 'now' }
  | { name: 'library' }
  | { name: 'project'; projectId: string }
  | { name: 'coach'; projectId: string }
  | { name: 'task'; projectId: string; taskId: string }
  | { name: 'history' }
  | { name: 'profile' }
  | { name: 'focus'; scope: FocusScope }

export interface NavigationProps {
  onNavigate: (view: View) => void
  onOpenProject: (projectId: string, taskId?: string) => void
  onOpenFocus: (scope?: FocusScope) => void
}
