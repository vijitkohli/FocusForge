import fs from 'fs-extra'
import { UserProfileNote, UserProfileSection, USER_PROFILE_SECTIONS } from '../../common/types'
import { USER_PROFILE_PATH, ProjectSummary } from './paths'
import { appendUnderHeading, trimSectionBullets } from './markdownSections'

// "Projects Overview" is machine-owned and always regenerated on prompt-read,
// never a valid LLM note target — so it's absent from USER_PROFILE_SECTIONS.
const USER_PROFILE_TRIMMED: UserProfileSection[] = ['Patterns & Friction']
const MAX_USER_PROFILE_BULLETS = 20

const OVERVIEW_HEADING = '## Projects Overview'

export function emptyUserProfile(): string {
  const editable = USER_PROFILE_SECTIONS.map((s) => `## ${s}\n`).join('\n')
  return editable + `\n${OVERVIEW_HEADING}\n_(auto-generated — do not hand-edit)_\n`
}

/**
 * Owns the global user profile (system/user_profile.md). Takes a `getProjects`
 * accessor (rather than importing ProjectStore) so it can rebuild the
 * machine-owned "Projects Overview" section without a circular dependency.
 */
export class ProfileStore {
  constructor(private getProjects: () => ProjectSummary[]) {}

  /** Full file, lazily created on first access. */
  async readUserProfile(): Promise<string> {
    try {
      if (!(await fs.pathExists(USER_PROFILE_PATH))) {
        await fs.outputFile(USER_PROFILE_PATH, emptyUserProfile())
        return emptyUserProfile()
      }
      return await fs.readFile(USER_PROFILE_PATH, 'utf-8')
    } catch (error) {
      console.error('Failed to read user profile:', error)
      return emptyUserProfile()
    }
  }

  /**
   * Overwrites the profile (from the editor). Validates that all user-editable
   * headings are present so appendUserProfileNotes can't fail.
   */
  async writeUserProfile(contents: string): Promise<{ success: boolean; error?: string }> {
    const missing = USER_PROFILE_SECTIONS.filter((s) => !contents.includes(`## ${s}`))
    if (missing.length > 0) {
      return {
        success: false,
        error: `Missing required section(s): ${missing.map((s) => `"## ${s}"`).join(', ')}`
      }
    }
    try {
      await fs.outputFile(USER_PROFILE_PATH, contents)
      return { success: true }
    } catch (error) {
      console.error('Failed to write user profile:', error)
      return { success: false, error: String(error) }
    }
  }

  /** Appends LLM-extracted user facts under the appropriate section headings. */
  async appendUserProfileNotes(notes: UserProfileNote[]): Promise<void> {
    if (!notes || notes.length === 0) return
    let contents = await this.readUserProfile()
    for (const { section, note } of notes) {
      if (!USER_PROFILE_SECTIONS.includes(section)) continue
      contents = appendUnderHeading(contents, section, `- ${note.replace(/^- /, '')}`)
    }
    await fs.outputFile(USER_PROFILE_PATH, contents)
  }

  /**
   * Profile variant for LLM injection: trims append-heavy sections and rewrites
   * "## Projects Overview" with a live summary from the registry. This is what
   * the engine actually receives — never grows stale.
   */
  async readUserProfileForPrompt(): Promise<string> {
    let contents = await this.readUserProfile()

    for (const section of USER_PROFILE_TRIMMED) {
      contents = trimSectionBullets(contents, section, MAX_USER_PROFILE_BULLETS)
    }

    const today = Date.now()
    const overviewLines = this.getProjects().map((p) => {
      const daysSince = Math.floor(
        (today - new Date(p.lastActive).getTime()) / (1000 * 60 * 60 * 24)
      )
      const idle = daysSince === 0 ? 'active today' : `last active ${daysSince}d ago`
      return `- ${p.name}: ${p.progress}% done, ${idle}`
    })
    const overviewBlock = `${OVERVIEW_HEADING}\n_(auto-generated)_\n${overviewLines.join('\n')}\n`

    const overviewIndex = contents.indexOf(OVERVIEW_HEADING)
    if (overviewIndex === -1) {
      contents = contents.trimEnd() + '\n\n' + overviewBlock
    } else {
      contents = contents.slice(0, overviewIndex) + overviewBlock
    }

    return contents
  }
}
