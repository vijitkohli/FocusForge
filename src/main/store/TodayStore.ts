import fs from 'fs-extra'
import { TodayPlan, planForToday } from '../../common/today'
import { TODAY_PLAN_PATH, localDateKey } from './paths'
import { writeJsonAtomic } from './atomic'
import { withLock } from './locks'

/** Persists the "Plan today" set in system/today.json; yesterday's plan reads as none. */
export class TodayStore {
  async get(now = new Date()): Promise<TodayPlan | null> {
    try {
      if (!(await fs.pathExists(TODAY_PLAN_PATH))) return null
      return planForToday(await fs.readJSON(TODAY_PLAN_PATH), localDateKey(now))
    } catch (error) {
      console.error('Failed to read today plan', error)
      return null
    }
  }

  save(plan: TodayPlan | null): Promise<TodayPlan | null> {
    return withLock('today', async () => {
      if (plan === null) {
        await fs.remove(TODAY_PLAN_PATH)
        return null
      }
      await writeJsonAtomic(TODAY_PLAN_PATH, plan)
      return plan
    })
  }
}
