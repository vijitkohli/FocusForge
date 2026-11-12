// src/main/vault/render.ts
// Item, task and About notes as Markdown. Pure and deterministic: the same
// input always gives the same bytes (no clocks; `today` comes in).
import { normalizeTitle } from '../../common/merge'
import { currentMilestoneOf, nextStepFor } from '../../common/nextStep'
import {
  addDays,
  blockIdFor,
  citeFirst,
  escapeInline,
  formatMinutes,
  gapBlockId,
  localDateOf,
  sanitizeStateMarkdown,
  sourceLabel,
  stepBlockId,
  wikilink,
  yamlList,
  yamlScalar
} from './format'
import type {
  DigestSource,
  ItemDigest,
  ItemNoteInput,
  PlannedSubtask,
  RenderedNote,
  TaskNoteInput,
  TaskWithPlan,
  VaultLogEntry
} from './types'

export const CALLOUT = [
  '> [!info] Kept in sync by FocusForge',
  '> Tick a box here and FocusForge marks it done. Sections marked (auto), and the lines above them, are rewritten by the app, so edits there get replaced. Write under **My notes**: the app reads it and never changes it.'
].join('\n')

export const NOT_SUMMARISED =
  '_Not summarised yet. FocusForge reads this item’s sources in the background._'
export const NOT_PLANNED = '_Not planned yet. FocusForge plans it in the background._'

const LOG_MAX = 20
const LOG_DAYS = 30
const PAST_DUE_DAYS = 7

export function removedCallout(date: string): string {
  return `> [!warning] Removed from FocusForge on ${date}. This note is no longer updated.`
}

/** Hands out block ids once per note; a duplicate loses its id and is reported. */
class NoteBlocks {
  readonly checks: Record<string, boolean> = {}
  readonly warnings: string[] = []
  private readonly seen = new Set<string>()

  private take(id: string): string | null {
    if (this.seen.has(id)) {
      this.warnings.push(`Duplicate block id ${id} dropped`)
      return null
    }
    this.seen.add(id)
    return id
  }

  box(checked: boolean, text: string, id: string): string {
    const use = this.take(id)
    if (use) this.checks[use] = checked
    return `- [${checked ? 'x' : ' '}] ${text}${use ? ` ^${use}` : ''}`
  }

  /** A non-tickable line with a block id (milestones). */
  tag(text: string, id: string): string {
    const use = this.take(id)
    return use ? `${text} ^${use}` : text
  }
}

function stepText(title: string, minutes?: number): string {
  return `${escapeInline(title)}${minutes && minutes > 0 ? ` (${formatMinutes(minutes)})` : ''}`
}

function taskDeadline(t: TaskWithPlan): string | null {
  return t.deadlineKind === 'none' ? null : localDateOf(t.deadline)
}

function tentative(t: TaskWithPlan): string {
  return t.deadlineKind === 'tentative' ? ' (tentative)' : ''
}

function allDone(t: TaskWithPlan): boolean {
  return t.subtasks.length > 0 && t.subtasks.every((s) => s.isCompleted)
}

/** Deadline (null last), then createdAt, then original order. */
function byDeadline(tasks: TaskWithPlan[]): TaskWithPlan[] {
  return tasks
    .map((t, i) => ({ t, i, d: taskDeadline(t) }))
    .sort((a, b) => {
      if (a.d !== b.d) return a.d === null ? 1 : b.d === null ? -1 : a.d < b.d ? -1 : 1
      return String(a.t.createdAt).localeCompare(String(b.t.createdAt)) || a.i - b.i
    })
    .map((x) => x.t)
}

function logLines(log: VaultLogEntry[], today: string, taskId?: string): string[] {
  const since = addDays(today, -LOG_DAYS)
  const lines = log
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.date >= since && (taskId === undefined || e.taskId === taskId))
    .sort((a, b) => b.e.at.localeCompare(a.e.at) || b.i - a.i)
    .slice(0, LOG_MAX)
    .map(({ e }) => `- ${e.date} · ${escapeInline(e.text)}`)
  return lines.length ? lines : ['_Nothing yet._']
}

function section(title: string, lines: string[]): string {
  return [`## ${title} (auto)`, ...lines].join('\n')
}

function cite(sources: DigestSource[] | undefined): string {
  const c = citeFirst(sources)
  return c ? ` ${c}` : ''
}

/** Deadlines: task rows are tickable; digest-only dates are plain bullets. */
function deadlineLines(
  tasks: TaskWithPlan[],
  digest: ItemDigest | null,
  today: string,
  blocks: NoteBlocks
): string[] {
  const cutoff = addDays(today, -PAST_DUE_DAYS)
  const rows: { date: string | null; order: number; line: () => string }[] = []
  tasks.forEach((t, i) => {
    const date = taskDeadline(t)
    if (!date || t.auto === 'loose-ends') return
    const done = allDone(t)
    if (done && date < cutoff) return
    rows.push({
      date,
      order: i,
      line: () =>
        blocks.box(
          done,
          `${escapeInline(t.title)} [due:: ${date}]${tentative(t)}`,
          blockIdFor('t', t.id)
        )
    })
  })
  const seen = new Set<string>()
  for (const [k, d] of (digest?.dueDates ?? []).entries()) {
    const key = normalizeTitle(d.what)
    const date = localDateOf(d.date)
    if (!key || (date && date < cutoff)) continue
    const covered = tasks.some(
      (t) =>
        t.origin?.key === key ||
        (normalizeTitle(t.title) === key && date !== null && taskDeadline(t) === date)
    )
    const dupKey = `${key}|${date ?? ''}`
    if (covered || seen.has(dupKey)) continue
    seen.add(dupKey)
    const what = escapeInline(d.what)
    const tent = d.confidence === 'tentative' ? ' (tentative)' : ''
    const text = date
      ? `- ${what} [due:: ${date}]${tent}${cite(d.sources)}`
      : `- ${what} · ${d.when ? escapeInline(d.when) : 'date TBC'}${tent}${cite(d.sources)}`
    rows.push({ date, order: tasks.length + k, line: () => text })
  }
  rows.sort((a, b) => {
    if (a.date !== b.date)
      return a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? -1 : 1
    return a.order - b.order
  })
  return rows.length ? rows.map((r) => r.line()) : ['_No deadlines yet._']
}

function stateLines(digest: ItemDigest | null): string[] {
  if (!digest) return [NOT_SUMMARISED]
  const out: string[] = []
  if (digest.openItems.length) {
    out.push('**Open items**')
    for (const o of digest.openItems) {
      const status = o.status === 'blocked' || o.status === 'waiting' ? ` (${o.status})` : ''
      out.push(`- ${escapeInline(o.text)}${status}${cite(o.sources)}`)
    }
    out.push('')
  }
  if (digest.constraints?.length) {
    out.push('**Rules that bind plans**')
    for (const c of digest.constraints) out.push(`- ${escapeInline(c.text)}${cite(c.sources)}`)
    out.push('')
  }
  const state = sanitizeStateMarkdown(digest.currentState)
  if (state) out.push(state)
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.length ? out : [NOT_SUMMARISED]
}

function looseEndsLines(
  tasks: TaskWithPlan[],
  digest: ItemDigest | null,
  skip: PlannedSubtask | null,
  blocks: NoteBlocks
): string[] {
  const loose = tasks.find((t) => t.auto === 'loose-ends')
  if (!loose) return []
  const out: string[] = []
  for (const s of loose.subtasks) {
    if (!s.gapId || s.isCompleted || s === skip) continue
    const c = digest?.candidateTasks.find((x) => x.id === s.gapId)
    let text = stepText(s.title, s.timeEstimate)
    if (c?.why) text += ` — ${escapeInline(c.why)}`
    const label = c?.sources[0] ? `(${escapeInline(c.sources[0].label)}` : null
    // Phase 3 already ends the title with the citation; don't repeat it.
    if (label && !escapeInline(s.title).includes(label)) text += cite(c?.sources)
    out.push(blocks.box(false, text, gapBlockId(s.gapId)))
  }
  return out
}

function progressPercent(tasks: TaskWithPlan[]): number {
  const all = tasks.flatMap((t) => t.subtasks)
  return all.length ? Math.round((all.filter((s) => s.isCompleted).length / all.length) * 100) : 0
}

function nextDue(tasks: TaskWithPlan[], digest: ItemDigest | null, today: string): string | null {
  const dates = [
    ...tasks.filter((t) => !allDone(t) && t.auto !== 'loose-ends').map(taskDeadline),
    ...(digest?.dueDates ?? []).map((d) => localDateOf(d.date))
  ].filter((d): d is string => d !== null && d >= today)
  return dates.length ? dates.sort()[0] : null
}

export function renderItemNote(i: ItemNoteInput): RenderedNote {
  const { item, digest, today } = i
  const blocks = new NoteBlocks()
  const tasks = byDeadline(i.tasks)

  const pre = [`# ${escapeInline(item.name)}`, i.removedOn ? removedCallout(i.removedOn) : CALLOUT]
  const quotes: string[] = []
  if (digest?.goal) quotes.push(`> Goal: ${escapeInline(digest.goal)}`)
  if (digest?.suggestedKind && digest.suggestedKind !== item.kind) {
    quotes.push(`> FocusForge thinks this is a ${digest.suggestedKind} item. Change it in the app.`)
  }
  if (quotes.length) pre.push('', quotes.join('\n>\n'))

  const next = nextStepFor(tasks)
  const nextLines = next
    ? [
        blocks.box(
          false,
          stepText(next.step.title, next.step.timeEstimate),
          stepBlockId(next.task, next.step)
        )
      ]
    : ['_Nothing to do right now._']
  const skipGap = next && next.task.auto === 'loose-ends' && next.step.gapId ? next.step : null
  const loose = looseEndsLines(tasks, digest, skipGap, blocks)

  const taskLines = tasks.map((t) => {
    const rel = i.taskLinks[t.id]
    const name = rel ? wikilink(rel, t.title) : escapeInline(t.title)
    const done = t.subtasks.filter((s) => s.isCompleted).length
    const steps = t.subtasks.length ? `${done}/${t.subtasks.length} steps` : 'not planned yet'
    const date = taskDeadline(t)
    return `- ${name} · ${steps}${date ? ` · due ${date}${tentative(t)}` : ''}`
  })

  const parts = [
    pre.join('\n'),
    section('Next step', nextLines),
    ...(loose.length ? [section('Loose ends', loose)] : []),
    section('Tasks', taskLines.length ? taskLines : ['_No tasks yet._']),
    section('Deadlines', deadlineLines(tasks, digest, today, blocks)),
    section('State', stateLines(digest)),
    section('Log', logLines(i.log, today))
  ]

  return {
    frontmatter: [
      ['ff_id', yamlScalar(item.id)],
      ['ff_note', 'item'],
      ['category', yamlScalar(item.category)],
      ['kind', yamlScalar(item.kind)],
      ['status', i.removedOn ? 'removed' : yamlScalar(item.status)],
      ['sources', yamlList(item.sources.map((s) => sourceLabel(s, i)))],
      ['progress', String(progressPercent(tasks))],
      ['next_due', yamlScalar(nextDue(tasks, digest, today))]
    ],
    body: parts.join('\n\n') + '\n',
    checks: blocks.checks,
    warnings: blocks.warnings
  }
}

function milestoneLines(t: TaskWithPlan, blocks: NoteBlocks): string[] {
  const current = currentMilestoneOf(t)
  return (t.milestones ?? []).map((m, idx) => {
    const status = m.status === 'done' ? 'done' : m === current ? 'now' : 'next'
    const title = escapeInline(m.title)
    const shown = status === 'done' ? `~~${title}~~` : status === 'now' ? `**${title}**` : title
    const bits = [`${idx + 1}. ${shown}`]
    if (m.estimateMinutes > 0) bits.push(formatMinutes(m.estimateMinutes))
    if (m.doneWhen) bits.push(`done when: ${escapeInline(m.doneWhen)}`)
    const by = localDateOf(m.targetDate)
    if (by) bits.push(`by ${by}`)
    bits.push(status)
    return blocks.tag(bits.join(' · '), blockIdFor('m', t.id, m.id))
  })
}

function stepLines(t: TaskWithPlan, blocks: NoteBlocks): string[] {
  const box = (s: PlannedSubtask): string =>
    blocks.box(s.isCompleted, stepText(s.title, s.timeEstimate), stepBlockId(t, s))
  const prereqs = t.prerequisites ?? []
  if (t.subtasks.length === 0 && prereqs.length === 0) return [NOT_PLANNED]
  const out: string[] = []
  if (prereqs.length) {
    out.push('### Before you start')
    for (const p of prereqs) {
      out.push(
        blocks.box(p.isCompleted, stepText(p.title, p.timeEstimate), blockIdFor('p', t.id, p.id))
      )
    }
  }
  const ms = t.milestones ?? []
  if (ms.length === 0) {
    if (t.subtasks.length) {
      if (prereqs.length) out.push('### Steps')
      out.push(...t.subtasks.map(box))
    }
    return out
  }
  const current = currentMilestoneOf(t)
  const byId = new Map(ms.map((m) => [m.id, m]))
  const now = t.subtasks.filter((s) => current && s.milestoneId === current.id)
  const done = t.subtasks.filter((s) => s.milestoneId && byId.get(s.milestoneId)?.status === 'done')
  const other = t.subtasks.filter((s) => !s.milestoneId || !byId.has(s.milestoneId))
  // Steps staged for a later milestone stay hidden until it's current.
  if (current) {
    out.push(`### Now: ${escapeInline(current.title)}`)
    out.push(...(now.length ? now.map(box) : ['_Steps for this part are on their way._']))
  }
  if (done.length) out.push('### Done', ...done.map(box))
  if (other.length) out.push('### Other steps', ...other.map(box))
  return out
}

export function renderTaskNote(i: TaskNoteInput): RenderedNote {
  const { task: t, item } = i
  const blocks = new NoteBlocks()
  const date = taskDeadline(t)
  const done = t.subtasks.filter((s) => s.isCompleted).length
  const partOf = `Part of ${wikilink(i.itemRel, item.name)}${
    date ? ` · due [due:: ${date}]${tentative(t)}` : ''
  }`
  const parts = [
    [
      `# ${escapeInline(t.title)}`,
      i.removedOn ? removedCallout(i.removedOn) : CALLOUT,
      '',
      partOf
    ].join('\n')
  ]
  if (t.milestones?.length) parts.push(section('Milestones', milestoneLines(t, blocks)))
  parts.push(section('Steps', stepLines(t, blocks)))
  parts.push(section('Log', logLines(i.log, i.today, t.id)))
  return {
    frontmatter: [
      ['ff_id', yamlScalar(item.id)],
      ['ff_task', yamlScalar(t.id)],
      ['ff_note', 'task'],
      ['item', JSON.stringify(wikilink(i.itemRel, item.name))],
      ['deadline', yamlScalar(date)],
      ['deadline_kind', yamlScalar(t.deadlineKind ?? 'hard')],
      ['progress', yamlScalar(`${done}/${t.subtasks.length}`)],
      ...(i.removedOn ? ([['status', 'removed']] as [string, string][]) : [])
    ],
    body: parts.join('\n\n') + '\n',
    checks: blocks.checks,
    warnings: blocks.warnings
  }
}

/** The Dataview queries for the owner's Dashboard (FocusForge never edits the Dashboard). */
export function dataviewSnippet(): string {
  return [
    '```dataview',
    'TASK',
    'FROM "TODO" OR "FocusForge"',
    'WHERE !completed AND due',
    'SORT due ASC',
    '```',
    '```dataview',
    'TABLE WITHOUT ID L.text AS "From your sources", L.due AS Due',
    'FROM "FocusForge"',
    'FLATTEN file.lists AS L',
    'WHERE L.due AND !L.task AND L.due >= date(today) - dur(7 days)',
    'SORT L.due ASC',
    '```'
  ].join('\n')
}

export function renderAboutNote(): RenderedNote {
  const body = [
    '# About these notes',
    CALLOUT,
    '',
    section('What FocusForge owns', [
      'FocusForge keeps one note per item and one per task in this folder, and only ever writes inside `FocusForge/`.',
      '',
      '- Tick a box and FocusForge marks that step done. Untick it to undo.',
      '- Sections marked (auto), and the lines above them, are rewritten by the app.',
      '- Anything under **My notes** is yours: the app reads it and never changes it.',
      '- If you delete a note, FocusForge won’t recreate it unless you ask it to.'
    ]),
    section('Dashboard snippet', [
      'Paste this into your Dashboard to see every due date in one place:',
      '',
      dataviewSnippet()
    ])
  ].join('\n\n')
  return {
    frontmatter: [['ff_note', 'about']],
    body: body + '\n',
    checks: {},
    warnings: []
  }
}
