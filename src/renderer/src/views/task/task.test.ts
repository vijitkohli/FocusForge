import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setSubtaskStatus,
  withCompletion,
  type ProjectData,
  type ProjectTask,
  type Subtask
} from '../../../../common/types'
import { redistributeSchedule, rescheduleOverdue } from '../../../../common/schedule'
import { burndownData } from './burndownData'
import { Burndown } from './Burndown'
import { TaskHeader } from './TaskHeader'
import { StepRow } from './StepRow'
import { Prerequisites } from './Prerequisites'
import { AdjustPlan } from './AdjustPlan'
import { ReplanBanner } from './ReplanBanner'
import { KanbanBoard } from '../../components/KanbanBoard'
import { persistTaskChange } from './persistTaskChange'

const step = (id: string, completed = false): Subtask => ({
  id,
  title: `Step ${id}`,
  isCompleted: completed
})
const task = (): ProjectTask => ({
  id: 'task',
  title: 'Finish Lab 4',
  createdAt: '2026-10-01T00:00:00',
  deadline: '2026-10-20',
  status: 'active',
  depth: 'brief',
  model: 'old-model',
  subtasks: [
    step('one'),
    { ...step('done', true), completedAt: '2026-10-02T12:00:00', scheduledDate: '2026-10-02' }
  ],
  prerequisites: [
    { id: 'prep', title: 'Install tools', kind: 'setup', isCompleted: true, timeEstimate: 5 }
  ]
})
const noop = (): void => {}
const render = renderToStaticMarkup

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('burndown math and presentation', () => {
  it('folds legacy completions into the start and preserves timestamped stair steps', () => {
    const start = '2026-10-01T00:00:00'
    const end = '2026-10-10'
    const middle = '2026-10-05T12:00:00'
    const result = burndownData(
      [step('legacy', true), { ...step('dated', true), completedAt: middle }, step('left')],
      start,
      end,
      new Date('2026-10-06T00:00:00').getTime()
    )!
    const points = result.points.split(' ').map((point) => point.split(',').map(Number))
    expect(points[0][0]).toBe(0)
    expect(points[0][1]).toBeCloseTo(2 + 44 / 3)
    expect(points[1][0]).toBe(points[2][0])
    expect(points[1][1]).toBeCloseTo(2 + 44 / 3)
    expect(points[2][1]).toBeCloseTo(2 + 88 / 3)
    expect(points.at(-1)![1]).toBeCloseTo(2 + 88 / 3)
    expect(result.status).toBe('On track')
  })

  it('uses the existing half-step tolerance, singular/plural behind count, and neutral past-due wording', () => {
    const start = '2026-10-01T00:00:00'
    const end = '2026-10-10'
    const now = (value: string): number => new Date(value).getTime()
    expect(burndownData([step('a')], start, end, now(start))?.status).toBe('On track')
    expect(burndownData([step('a')], start, end, now('2026-10-09T00:00:00'))?.status).toBe(
      'Behind by ~1 step'
    )
    expect(
      burndownData([step('a'), step('b')], start, end, now('2026-10-09T00:00:00'))?.status
    ).toBe('Behind by ~2 steps')
    expect(burndownData([step('a')], start, end, now('2026-10-11T00:00:00'))?.status).toBe(
      'Past due date'
    )
    expect(burndownData([step('a', true)], start, end, now('2026-10-11T00:00:00'))?.status).toBe(
      'Complete'
    )
  })

  it('omits empty/invalid windows and clamps chart endpoints', () => {
    expect(burndownData([], '2026-10-01', '2026-10-10')).toBeNull()
    expect(burndownData([step('a')], 'invalid', '2026-10-10')).toBeNull()
    expect(burndownData([step('a')], '2026-10-20', '2026-10-10')).toBeNull()
    const data = burndownData(
      [step('a')],
      '2026-10-01',
      '2026-10-10',
      new Date('2026-10-20').getTime()
    )!
    expect(data.points.split(' ').at(-1)).toBe('240,2')
    const markup = render(createElement(Burndown, { data }))
    expect(markup).toContain('width="240" height="48"')
    expect(markup).toContain('stroke-width="1.5"')
    expect(markup).toContain('stroke-dasharray="4 4"')
  })
})

describe('task page sections', () => {
  it('counts prerequisites in header progress and presents neutral deadline status', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T12:00:00'))
    const markup = render(
      createElement(TaskHeader, {
        task: task(),
        projectName: 'COMP6991',
        disabled: false,
        onBack: noop,
        onPlay: noop,
        onNotes: noop,
        onDelete: noop,
        onDeadline: noop
      })
    )
    expect(markup).toContain('2 / 3 done')
    expect(markup).toContain('aria-valuenow="67"')
    expect(markup).toContain('Due Tue 20 Oct')
    expect(markup).toContain('Past due date')
    expect(markup).not.toContain('Overdue')
    expect(markup).toContain('Play next step')
    expect(markup).toContain('Task options')
    expect(markup).toContain('COMP6991')
  })

  it('disables completed-task playback and saving controls', () => {
    const current = task()
    current.subtasks = current.subtasks.map((item) => withCompletion(item, true))
    const markup = render(
      createElement(TaskHeader, {
        task: current,
        projectName: 'Project',
        disabled: true,
        onBack: noop,
        onPlay: noop,
        onNotes: noop,
        onDelete: noop,
        onDeadline: noop
      })
    )
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('Saving…')
    expect(markup).toContain('3 / 3 done')
  })

  it('uses plan numbering, canonical doing state, checkbox, and neutral done styling', () => {
    const doing = render(
      createElement(StepRow, {
        item: setSubtaskStatus(step('a'), 'doing'),
        index: 2,
        disabled: false,
        onToggle: noop,
        onEdit: noop,
        onDelete: noop
      })
    )
    expect(doing).toContain('Options for step 3')
    expect(doing).toContain('aria-label="Doing"')
    expect(doing).toContain('type="checkbox"')
    expect(doing).toContain('task-track-meta')
    expect(doing).not.toContain('border-l-')
    const done = render(
      createElement(StepRow, {
        item: step('a', true),
        index: 0,
        disabled: false,
        onToggle: noop,
        onEdit: noop,
        onDelete: noop
      })
    )
    expect(done).toContain('text-fg-3 line-through')
    expect(done).toContain('checked=""')
  })

  it('labels prerequisite kinds and preserves the exact completed-progress result note', () => {
    const prerequisites = render(
      createElement(Prerequisites, {
        items: task().prerequisites!,
        disabled: false,
        onToggle: noop
      })
    )
    expect(prerequisites).toContain('Before you start')
    expect(prerequisites).toContain('Set up')
    expect(prerequisites).toContain('5 min')
    const message = "Shortened the plan. (Kept 2 completed steps so your progress isn't lost.)"
    const markup = render(
      createElement(AdjustPlan, {
        request: '',
        message,
        disabled: true,
        adjusting: true,
        onChange: noop,
        onAdjust: noop,
        onStop: noop
      })
    )
    expect(markup).toContain('Change this plan')
    expect(markup).toContain('Adjusting your plan…')
    expect(markup).toContain('Stop')
    expect(markup).toContain('(Kept 2 completed steps so your progress isn&#x27;t lost.)')
    expect(markup).toContain('bg-bg-2')
  })

  it('keeps supportive re-plan copy without a colored border and hides an empty banner', () => {
    const markup = render(
      createElement(ReplanBanner, { count: 1, disabled: false, onReplan: noop })
    )
    expect(markup).toContain('1 step slipped past its planned day.')
    expect(markup).toContain('normal — want to fit it into the days ahead?')
    expect(markup).toContain('Re-plan from today')
    expect(markup).not.toContain('border-l')
    expect(render(createElement(ReplanBanner, { count: 0, disabled: false, onReplan: noop }))).toBe(
      ''
    )
  })

  it('renders responsive native draggable board cards with accessible move triggers and fg-2 metadata', () => {
    const markup = render(createElement(KanbanBoard, { subtasks: task().subtasks, onMove: noop }))
    expect(markup).toContain('To do, 1 steps')
    expect(markup).toContain('Doing, 0 steps')
    expect(markup).toContain('Done, 1 steps')
    expect(markup).toContain('draggable="true"')
    expect(markup).toContain('aria-label="Move Step one"')
    expect(markup).toContain('sm:grid-cols-3')
    expect(markup).not.toContain('text-fg-3')
    const disabled = render(
      createElement(KanbanBoard, { subtasks: task().subtasks, onMove: noop, disabled: true })
    )
    expect(disabled).toContain('draggable="false"')
  })
})

describe('manual task persistence with ledger notes', () => {
  function setup(): { disk: () => ProjectData; save: ReturnType<typeof vi.fn> } {
    let disk: ProjectData = { name: 'Project', tasks: [task(), { ...task(), id: 'other' }] }
    const save = vi.fn(async (_projectId: string, data: ProjectData) => {
      disk = structuredClone(data)
      return { success: true }
    })
    vi.stubGlobal('window', {
      api: { loadProjectData: vi.fn(async () => structuredClone(disk)), saveProjectData: save }
    })
    return { disk: () => disk, save }
  }
  const note = {
    section: 'Milestones & Completed Work',
    note: 'Marked "Step one" as complete.'
  } as const

  it('uses updateTask and canonical completion, retaining other tasks and completion history', async () => {
    const { disk, save } = setup()
    const saved = await persistTaskChange(
      'project',
      'task',
      (current) => ({
        ...current,
        subtasks: current.subtasks.map((item) =>
          item.id === 'one' ? withCompletion(item, true) : item
        )
      }),
      note
    )
    expect(saved.subtasks[0]).toMatchObject({
      isCompleted: true,
      status: 'done',
      completedAt: expect.any(String)
    })
    expect(saved.subtasks[1]).toEqual(task().subtasks[1])
    expect(disk().tasks[1]).toEqual({ ...task(), id: 'other' })
    expect(save).toHaveBeenCalledWith('project', disk(), [note], 0)
  })

  it('does not report success when saveProjectData returns a failure flag', async () => {
    const { save, disk } = setup()
    save.mockImplementationOnce(async () => ({ success: false }))
    await expect(
      persistTaskChange('project', 'task', (current) => ({ ...current, title: 'New title' }), note)
    ).rejects.toThrow('not saved to disk')
    expect(disk().tasks[0].title).toBe('Finish Lab 4')
  })

  it('propagates specific disk failures and detects missing tasks', async () => {
    const { save } = setup()
    save.mockRejectedValueOnce(new Error('Permission denied'))
    await expect(persistTaskChange('project', 'task', (current) => current, note)).rejects.toThrow(
      'Permission denied'
    )
    await expect(
      persistTaskChange('project', 'missing', (current) => current, note)
    ).rejects.toThrow('no longer exists')
  })

  it('persists deadline redistribution without changing completed schedule/timestamps', async () => {
    setup()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T12:00:00'))
    const saved = await persistTaskChange(
      'project',
      'task',
      (current) => ({
        ...current,
        deadline: '2026-10-25',
        subtasks: redistributeSchedule(current.subtasks, '2026-10-25')
      }),
      { section: 'Plan Adjustments', note: 'Deadline changed; remaining steps rescheduled.' }
    )
    expect(saved.deadline).toBe('2026-10-25')
    expect(saved.subtasks[0].scheduledDate).toBe('2026-10-25')
    expect(saved.subtasks[1]).toEqual(task().subtasks[1])
  })

  it('retains the existing slipped-step recovery scheduling behavior', () => {
    const items = [
      { ...step('late'), scheduledDate: '2026-10-01' },
      { ...step('future'), scheduledDate: '2026-10-20' },
      { ...step('done', true), scheduledDate: '2026-10-01' }
    ]
    const result = rescheduleOverdue(items, '2026-10-25', '2026-10-15')
    expect(result.moved).toBe(1)
    expect(result.subtasks[0].scheduledDate).toBe('2026-10-15')
    expect(result.subtasks.slice(1)).toEqual(items.slice(1))
  })
})
