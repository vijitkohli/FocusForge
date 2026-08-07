import fs from 'fs-extra'
import { NUDGE_LOG_PATH, localDateKey } from './paths'
import { ProjectStore } from './ProjectStore'
import { Analytics } from './Analytics'

// How stale a project must be (days since lastActive) before it's nudge-worthy.
const NUDGE_IDLE_DAYS = 2

// Warm, never-guilty nudge copy. `{name}` is interpolated.
const NUDGE_TEMPLATES = [
  'No pressure — want to spend 10 min on "{name}"? Starting is the hard part.',
  '"{name}" is waiting whenever you are. One tiny step today is a win.',
  'Got 10 minutes? "{name}" could use a little momentum. You\'ve got this.',
  'A small start on "{name}" beats a perfect plan. Want to knock out one step?'
]

/**
 * Decides whether to gently nudge the user and returns the notification copy if
 * so. Supportive, never guilt-trippy. Picks ONE item (most overdue step, else a
 * stale project with open work), respects quiet hours (08:00–22:00 only) and an
 * at-most-once-per-item-per-day guard persisted in system/nudges.json.
 */
export class Nudger {
  constructor(
    private projects: ProjectStore,
    private analytics: Analytics
  ) {}

  async getNudge(): Promise<{ title: string; body: string } | null> {
    const hour = new Date().getHours()
    if (hour < 8 || hour >= 22) return null // quiet hours

    const upcoming = await this.analytics.getUpcomingSubtasks()
    if (upcoming.length === 0) return null

    const todayKey = localDateKey(new Date())
    let log: Record<string, string> = {}
    try {
      if (await fs.pathExists(NUDGE_LOG_PATH)) log = await fs.readJSON(NUDGE_LOG_PATH)
    } catch {
      log = {}
    }
    const alreadyNudged = (key: string): boolean => log[key] === todayKey

    // 1. Most overdue incomplete step (upcoming is sorted soonest-first).
    let pick: { key: string; name: string } | null = null
    const mostUrgent = upcoming[0]
    if (mostUrgent.daysRemaining < 0 && !alreadyNudged(`sub:${mostUrgent.subtaskId}`)) {
      pick = { key: `sub:${mostUrgent.subtaskId}`, name: mostUrgent.subtaskTitle }
    }

    // 2. Otherwise, a project with open work that's gone quiet.
    if (!pick) {
      const projectsWithWork = new Set(upcoming.map((s) => s.projectId))
      const now = Date.now()
      const stale = this.projects
        .getProjects()
        .filter((p) => projectsWithWork.has(p.id))
        .filter((p) => (now - new Date(p.lastActive).getTime()) / 86400000 >= NUDGE_IDLE_DAYS)
        .filter((p) => !alreadyNudged(`proj:${p.id}`))
        .sort((a, b) => new Date(a.lastActive).getTime() - new Date(b.lastActive).getTime())
      if (stale.length > 0) {
        pick = { key: `proj:${stale[0].id}`, name: stale[0].name }
      }
    }

    if (!pick) return null

    log[pick.key] = todayKey
    try {
      await fs.outputJSON(NUDGE_LOG_PATH, log)
    } catch (e) {
      console.error('Failed to write nudge log', e)
    }

    const template = NUDGE_TEMPLATES[Math.floor(Math.random() * NUDGE_TEMPLATES.length)]
    return { title: 'Flow State', body: template.replace('{name}', pick.name) }
  }
}
