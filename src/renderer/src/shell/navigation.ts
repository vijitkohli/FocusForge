import type { FocusScope } from '../components/FocusMode'

export type { FocusScope }

export type View =
  | { name: 'now' }
  | { name: 'library' }
  | { name: 'project'; projectId: string }
  // planTaskId: plan an existing unplanned task (e.g. imported from a course outline)
  | { name: 'coach'; projectId: string; planTaskId?: string }
  | { name: 'task'; projectId: string; taskId: string }
  | { name: 'history' }
  | { name: 'profile' }
  | { name: 'focus'; scope: FocusScope }

export interface NavigationProps {
  onNavigate: (view: View) => void
  onOpenProject: (projectId: string, taskId?: string) => void
  onOpenFocus: (scope?: FocusScope) => void
}
