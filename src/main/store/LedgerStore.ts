import fs from 'fs-extra'
import { LedgerNote, LedgerSection, LEDGER_SECTIONS } from '../../common/types'
import { ledgerPath, legacyLedgerPath } from './paths'
import { appendUnderHeading, trimSectionBullets } from './markdownSections'

export function emptyLedgerContents(): string {
  return LEDGER_SECTIONS.map((section) => `## ${section}\n`).join('\n')
}

// Sections whose bullet history gets trimmed for the prompt-bound read —
// append-only logs where older entries lose relevance once superseded.
const TRIMMED_SECTIONS: LedgerSection[] = ['Milestones & Completed Work', 'Plan Adjustments']
const MAX_BULLETS_PER_TRIMMED_SECTION = 15

/**
 * Owns the per-project context ledger (context_<projectId>.md): the single
 * combined source of truth for a project across all its tasks. Handles lazy
 * creation, legacy-filename migration, the full/trimmed reads, and appending
 * self-describing notes under the fixed section headings.
 */
export class LedgerStore {
  /**
   * Reads the full ledger for a project, lazily creating an empty one if it's
   * missing and migrating the legacy `context.md` filename in place if found.
   */
  async readContextLedger(projectId: string): Promise<string> {
    const target = ledgerPath(projectId)
    try {
      if (!(await fs.pathExists(target))) {
        const legacy = legacyLedgerPath(projectId)
        if (await fs.pathExists(legacy)) {
          await fs.move(legacy, target)
          return await fs.readFile(target, 'utf-8')
        }
        await fs.outputFile(target, emptyLedgerContents())
        return emptyLedgerContents()
      }
      return await fs.readFile(target, 'utf-8')
    } catch (error) {
      console.error(`Failed to read context ledger for ${projectId}:`, error)
      return emptyLedgerContents()
    }
  }

  /**
   * Overwrites a project's ledger with user-edited contents (the editable
   * "View Project Context" panel). Auto-append + trimmed prompt-read still work
   * as long as the user keeps the `## <Section>` headings intact.
   */
  async writeContextLedger(
    projectId: string,
    contents: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await fs.outputFile(ledgerPath(projectId), contents)
      return { success: true }
    } catch (error) {
      console.error(`Failed to write context ledger for ${projectId}:`, error)
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Like readContextLedger, but trims the append-only log sections down to
   * their most recent bullets — this is the string sent to the LLM on every
   * turn, so an old project's ledger doesn't grow into an ever-larger prompt.
   * The untrimmed file (readContextLedger) is still what the UI viewer shows.
   */
  async readContextLedgerForPrompt(projectId: string): Promise<string> {
    let contents = await this.readContextLedger(projectId)
    for (const section of TRIMMED_SECTIONS) {
      contents = trimSectionBullets(contents, section, MAX_BULLETS_PER_TRIMMED_SECTION)
    }
    return contents
  }

  /**
   * Appends each note under its section heading. Missing headings (older or
   * malformed ledgers) are created at the end before appending.
   */
  async appendLedgerNotes(projectId: string, notes: LedgerNote[]): Promise<void> {
    let contents = await this.readContextLedger(projectId)
    const timestamp = new Date().toISOString().split('T')[0]
    for (const { section, note } of notes) {
      contents = appendUnderHeading(contents, section, `- [${timestamp}] ${note}`)
    }
    await fs.outputFile(ledgerPath(projectId), contents)
  }
}
