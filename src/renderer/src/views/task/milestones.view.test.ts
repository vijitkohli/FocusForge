import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Milestone, ProjectTask, Subtask } from '../../../../common/types'
import { visibleSteps } from '../../../../common/milestones'
import { burndownData } from './burndownData'
import { Milestones } from './Milestones'
import { milestoneSummary } from './milestoneLabels'

const start = '2026-11-01T00:00:00'
const deadline = '2026-11-11'
const at = (iso: string): number => new Date(iso).getTime()

function ms(
  id: string,
  status: Milestone['status'],
  est: number,
  extra: Partial<Milestone> = {}
): Milestone {
  return {
    id,
    title: `Part ${id}`,
    estimateMinutes: est,
    doneWhen: `${id} finished`,
    status,
    ...extra
  }
}
function step(
  id: string,
  mid: string | undefined,
  done = false,
  extra: Partial<Subtask> = {}
): Subtask {
  return {
    id,
    title: `Step ${id}`,
    isCompleted: done,
    timeEstimate: 30,
    ...(mid ? { milestoneId: mid } : {}),
    ...extra
  }
}
function task(milestones: Milestone[] | undefined, subtasks: Subtask[]): ProjectTask {
  return {
    id: 't',
    title: 'T',
    createdAt: start,
    deadline,
    status: 'in-progress',
    depth: 'Deep',
    model: '',
    subtasks,
    ...(milestones ? { milestones } : {})
  }
}

describe('two-level task view', () => {
  it('burndown uses minutes when milestones present', () => {
    const milestones = [
      ms('m1', 'done', 120, { completedAt: '2026-11-03T12:00:00' }),
      ms('m2', 'active', 480)
    ]
    const steps = [
      step('a', 'm1', true, { completedAt: '2026-11-02T12:00:00' }),
      step('b', 'm2', true, { completedAt: '2026-11-04T12:00:00' })
    ]
    const out = burndownData(steps, start, deadline, at('2026-11-06T00:00:00'), milestones)
    expect(out).not.toBeNull()
    // 600 total; 30 (a) + 90 (rest of m1) + 30 (b) = 150 done -> 450 left vs ~327 ideal -> behind ~2 h
    expect(out?.status).toBe('Behind by ~2 h')
    expect(out?.points.split(' ')).toHaveLength(8)
  })

  it('burndown unchanged for legacy task', () => {
    const steps = [
      step('a', undefined, true, { completedAt: '2026-11-02T12:00:00' }),
      step('b', undefined)
    ]
    const legacy = burndownData(steps, start, deadline, at('2026-11-06T00:00:00'))
    const withEmpty = burndownData(steps, start, deadline, at('2026-11-06T00:00:00'), [])
    expect(withEmpty).toEqual(legacy)
    expect(legacy?.status).toBe('On track')
  })

  it('visibleSteps groups current, earlier, unassigned', () => {
    const t = task(
      [ms('m1', 'done', 60), ms('m2', 'active', 60), ms('m3', 'todo', 60)],
      [step('a', 'm1', true), step('b', 'm2'), step('c', 'm3'), step('d', undefined)]
    )
    const g = visibleSteps(t)
    expect([g.current, g.earlier, g.unassigned].map((xs) => xs.map((s) => s.id))).toEqual([
      ['b'],
      ['a'],
      ['d']
    ])
  })

  it('Milestones renders nothing without milestones', () => {
    const html = renderToStaticMarkup(
      createElement(Milestones, {
        task: task(undefined, [step('a', undefined)]),
        disabled: false,
        onSetDone: () => {}
      })
    )
    expect(html).toBe('')
  })

  it('Milestones shows the whole job and the active done-when', () => {
    const t = task(
      [
        ms('m1', 'done', 120),
        ms('m2', 'active', 480),
        ms('m3', 'todo', 540, { targetDate: '2026-11-09' })
      ],
      []
    )
    const html = renderToStaticMarkup(
      createElement(Milestones, { task: t, disabled: false, onSetDone: () => {} })
    )
    expect(milestoneSummary(t)).toBe('The whole job · ~19 h · 1 of 3 parts done')
    expect(html).toContain('The whole job · ~19 h · 1 of 3 parts done')
    expect(html).toContain('Done when: m2 finished')
    expect(html).toContain('aria-current="step"')
  })
})
