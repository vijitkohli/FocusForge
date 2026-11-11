import fs from 'fs-extra'
import path from 'path'
import { WeeklyReview } from '../../common/review'
import { REVIEWS_DIR } from './paths'
import { writeJsonAtomic } from './atomic'
import { withLock } from './locks'

const KEEP_REVIEWS = 26
const FILE = /^\d{4}-\d{2}-\d{2}\.json$/

/** Weekly reviews in system/reviews/<weekStart>.json, newest first. */
export class Reviews {
  async list(limit = KEEP_REVIEWS): Promise<WeeklyReview[]> {
    try {
      if (!(await fs.pathExists(REVIEWS_DIR))) return []
      const names = (await fs.readdir(REVIEWS_DIR))
        .filter((n) => FILE.test(n))
        .sort()
        .reverse()
      const reviews: WeeklyReview[] = []
      for (const name of names.slice(0, limit)) {
        try {
          reviews.push(await fs.readJSON(path.join(REVIEWS_DIR, name)))
        } catch {
          // skip a damaged file
        }
      }
      return reviews
    } catch (error) {
      console.error('Failed to list weekly reviews', error)
      return []
    }
  }

  has(weekStart: string): Promise<boolean> {
    return fs.pathExists(path.join(REVIEWS_DIR, `${weekStart}.json`))
  }

  save(review: WeeklyReview): Promise<void> {
    return withLock('reviews', () =>
      writeJsonAtomic(path.join(REVIEWS_DIR, `${review.weekStart}.json`), review)
    )
  }
}
