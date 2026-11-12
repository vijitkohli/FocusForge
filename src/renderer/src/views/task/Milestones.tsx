import type { JSX } from 'react'
import { Check } from 'lucide-react'
import type { Milestone, ProjectTask } from '../../../../common/types'
import { currentMilestone, hasMilestones } from '../../../../common/milestones'
import { DayLabel, Menu } from '../../ui'
import { durationLabel, milestoneSummary } from './milestoneLabels'

function Glyph({ status }: { status: Milestone['status'] }): JSX.Element {
  if (status === 'done')
    return (
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-easy text-bg-0">
        <Check size={11} strokeWidth={3} aria-hidden="true" />
      </span>
    )
  if (status === 'active')
    return <span className="mt-1 size-2.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
  return (
    <span className="mt-0.5 size-4 shrink-0 rounded-full border border-line" aria-hidden="true" />
  )
}

/**
 * The whole job as milestones. Renders nothing for tasks without milestones,
 * so old tasks look exactly as before.
 */
export function Milestones({
  task,
  disabled,
  onSetDone
}: {
  task: ProjectTask
  disabled: boolean
  onSetDone: (milestoneId: string, done: boolean) => void
}): JSX.Element | null {
  if (!hasMilestones(task)) return null
  const current = currentMilestone(task)
  const ms = task.milestones ?? []
  return (
    <section aria-labelledby="task-milestones-title" className="min-w-0">
      <h2 id="task-milestones-title" className="section-title mb-1">
        Parts
      </h2>
      <p className="meta mb-3 text-fg-2">{milestoneSummary(task)}</p>
      <ol className="space-y-1">
        {ms.map((m, index) => {
          const active = current?.id === m.id
          const status = m.status === 'done' ? 'done' : active ? 'active' : 'todo'
          return (
            <li
              key={m.id}
              aria-current={active ? 'step' : undefined}
              className={`flex items-start gap-3 rounded-md px-3 py-2 ${active ? 'bg-bg-2' : ''}`}
            >
              <Glyph status={status} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span
                    className={`min-w-0 text-sm [overflow-wrap:anywhere] ${status === 'done' ? 'text-fg-3 line-through' : 'text-fg-1'}`}
                  >
                    <span className="sr-only">Part {index + 1}: </span>
                    {m.title}
                  </span>
                  <span className="meta tabular-nums text-fg-3">
                    {durationLabel(m.estimateMinutes)}
                  </span>
                  {m.targetDate && status !== 'done' && (
                    <DayLabel date={m.targetDate} className="meta" />
                  )}
                </div>
                {active
                  ? m.doneWhen && <p className="meta mt-1 text-fg-2">Done when: {m.doneWhen}</p>
                  : m.doneWhen && (
                      <details className="mt-1">
                        <summary className="meta cursor-pointer text-fg-3">Done when</summary>
                        <p className="meta text-fg-2">{m.doneWhen}</p>
                      </details>
                    )}
              </div>
              {(active || status === 'done') && (
                <Menu
                  label={`Options for ${m.title}`}
                  disabled={disabled}
                  items={
                    status === 'done'
                      ? [
                          {
                            id: 'reopen',
                            label: 'Not done yet',
                            onSelect: () => onSetDone(m.id, false)
                          }
                        ]
                      : [
                          {
                            id: 'done',
                            label: "This part's done",
                            onSelect: () => onSetDone(m.id, true)
                          }
                        ]
                  }
                />
              )}
            </li>
          )
        })}
      </ol>
      {(task.planAssumptions ?? []).length > 0 && (
        <details className="mt-3">
          <summary className="meta cursor-pointer text-fg-3">What the plan assumed</summary>
          <ul className="meta mt-1 list-disc space-y-1 pl-5 text-fg-2">
            {(task.planAssumptions ?? []).map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
