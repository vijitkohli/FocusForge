import { useEffect, useRef, useState, type JSX, type RefObject } from 'react'
import { Check, Disc3, SkipForward } from 'lucide-react'
import { localDateKey } from 'src/common/schedule'
import type { UpcomingSubtask } from 'src/common/types'
import { coverFor } from '../lib/cover'
import { dayLabel } from '../lib/dates'
import { queueKey, queueStore, useQueue } from '../lib/queue'
import { dueDays } from '../lib/whatNext'
import { useWhatNext, whatNextStore, type WhatNextSnapshot } from '../lib/whatNextStore'
import type { NavigationProps } from '../shell/navigation'
import { Button, Cover, DifficultyTag, EmptyState, PlayButton, SegmentedControl } from '../ui'
import { Scrubber } from './Scrubber'
import { SkipReasons } from './SkipReasons'
import type { EnergyChip } from 'src/common/whatNext'

const CHIPS: { value: EnergyChip; label: string }[] = [
  { value: 'anything', label: 'Anything' },
  { value: 'deadline', label: 'Deadline' },
  { value: 'different', label: 'Something different' },
  { value: 'light', label: 'Light' }
]

function shownItem(
  all: readonly UpcomingSubtask[],
  loaded: boolean,
  current: UpcomingSubtask | null,
  wn: WhatNextSnapshot
): UpcomingSubtask | null {
  if (!loaded) return null
  if (wn.userPicked) return current
  const key = wn.pinnedKey ?? wn.result?.pick?.input.key ?? null
  if (!key) return null
  return all.find((item) => queueKey(item) === key) ?? null
}

export function WhatNextCard({
  compact,
  hasProjects,
  onNavigate,
  onOpenProject,
  onPlay,
  saving,
  onDone
}: {
  compact: boolean
  hasProjects: boolean
  onPlay: () => void
  saving: boolean
  onDone: () => void
} & Pick<NavigationProps, 'onNavigate' | 'onOpenProject'>): JSX.Element | null {
  const queue = useQueue()
  const wn = useWhatNext()
  const notThisRef = useRef<HTMLButtonElement>(null)
  const armed = useRef(false)
  const [projectCount, setProjectCount] = useState<number | null>(hasProjects ? 1 : 0)
  const shown = shownItem(queue.all, queue.loaded, queue.current, wn)
  // The picker ranks one step per task. Skip, and a mood that doesn't fit that
  // step, still leave later steps in the queue. Show those instead of an empty card.
  const queueFallback =
    !shown &&
    queue.loaded &&
    queue.current &&
    (wn.result?.empty === 'mood' ||
      wn.result?.empty === 'all-skipped' ||
      wn.result?.empty === 'no-steps' ||
      wn.result == null)
      ? queue.current
      : null
  const display = shown ?? queueFallback
  const stale = !queue.loaded ? wn.lastKnown : null

  useEffect(() => {
    let cancelled = false
    void window.api
      .getProjects()
      .then((list) => {
        if (!cancelled)
          setProjectCount(list.filter((p) => (p.status ?? 'active') === 'active').length)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!queue.loaded || !armed.current) return
    armed.current = false
    const known = wn.lastKnown
    if (known && !queue.all.some((item) => queueKey(item) === known.key)) {
      whatNextStore.setNotice("That one's already done. Here's the next.")
      return
    }
    if (queue.current) onPlay()
  }, [queue, wn.lastKnown, onPlay])

  const title = display?.subtaskTitle ?? stale?.stepTitle ?? ''
  useEffect(() => {
    if (!title) return
    const node = document.getElementById('what-next-live')
    if (node) node.textContent = `Next up: ${title}. ${wn.reason}.`
  }, [title, wn.reason])

  if (!queue.loaded && !stale) return null

  function start(): void {
    if (!queue.loaded) {
      armed.current = true
      return
    }
    if (!display) {
      whatNextStore.setNotice("That one's already done. Here's the next.")
      return
    }
    onPlay()
  }

  function notThis(): void {
    whatNextStore.notThis()
    notThisRef.current?.focus()
  }

  const aside = wn.result?.urgentAside
  const asideDays = aside ? dueDays(aside.input.due?.date ?? null, new Date()) : null
  const asideWhen = asideDays === 0 ? 'today' : asideDays === 1 ? 'tomorrow' : 'soon'
  const urgentFirst =
    !!wn.result?.pick?.urgent &&
    (wn.chip === 'anything' || wn.chip === 'deadline') &&
    !wn.userPicked &&
    !wn.pinnedKey

  return (
    <section
      aria-labelledby="what-next-heading"
      aria-busy={!queue.loaded || undefined}
      className="now-panel flex min-w-0 flex-col rounded-md bg-bg-2 !p-5"
      data-what-next="card"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="what-next-heading" className="section-title">
          What next?
        </h2>
        <SegmentedControl<EnergyChip>
          label="Energy"
          value={wn.chip}
          onChange={whatNextStore.setChip}
          className="max-w-full flex-wrap"
          options={CHIPS}
        />
      </div>
      <p id="what-next-live" className="sr-only" aria-live="polite" />
      {display || stale ? (
        <CardBody
          compact={compact}
          item={display}
          stale={stale}
          reason={
            queueFallback
              ? ''
              : wn.userPicked
                ? 'You picked this one.'
                : wn.reason || stale?.reason || ''
          }
          urgentFirst={urgentFirst}
          aside={
            aside && (wn.chip === 'different' || wn.chip === 'light')
              ? `${aside.input.step.itemName ?? aside.input.step.projectId} is due ${asideWhen}. It'll be here when you want it.`
              : null
          }
          onShowAside={() => whatNextStore.setChip('anything')}
          onOpen={() => {
            const projectId = display?.projectId ?? stale?.projectId
            const taskId = display?.taskId
            if (projectId) onOpenProject(projectId, taskId)
          }}
          saving={saving}
          notThisRef={notThisRef}
          onNotThis={notThis}
          onStart={start}
          onDone={onDone}
          notice={wn.notice}
          splitting={wn.splitting}
          reasons={wn.reasons}
        />
      ) : (
        <CardEmpty wn={wn} projectCount={projectCount} mood={queue.mood} onNavigate={onNavigate} />
      )}
      {wn.reasons && !display && (
        <SkipReasons
          prompt={wn.reasons}
          onReason={(reason) => void whatNextStore.setReason(reason)}
          onTooBig={() => void whatNextStore.tooBig()}
          onBringBack={() => whatNextStore.bringBack()}
        />
      )}
    </section>
  )
}

function CardBody({
  compact,
  item,
  stale,
  reason,
  urgentFirst,
  aside,
  onShowAside,
  onOpen,
  saving,
  notThisRef,
  onNotThis,
  onStart,
  onDone,
  notice,
  splitting,
  reasons
}: {
  compact: boolean
  item: UpcomingSubtask | null
  stale: WhatNextSnapshot['lastKnown']
  reason: string
  urgentFirst: boolean
  aside: string | null
  onShowAside: () => void
  onOpen: () => void
  saving: boolean
  notThisRef: RefObject<HTMLButtonElement | null>
  onNotThis: () => void
  onStart: () => void
  onDone: () => void
  notice: string | null
  splitting: boolean
  reasons: WhatNextSnapshot['reasons']
}): JSX.Element {
  const projectId = item?.projectId ?? stale?.projectId ?? ''
  const name = item?.projectName ?? stale?.itemName ?? ''
  const taskTitle = item?.taskTitle ?? stale?.taskTitle ?? ''
  const stepTitle = item?.subtaskTitle ?? stale?.stepTitle ?? ''
  const minutes = item?.timeEstimate || stale?.minutes || 15
  const difficulty = item?.difficulty ?? stale?.difficulty ?? 'medium'
  const carried = item?.scheduledDate && item.scheduledDate < localDateKey(new Date())
  return (
    <>
      {urgentFirst && <p className="mb-3 text-sm text-fg-2">It’s due soon, so it’s up first.</p>}
      {aside && (
        <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-fg-2">
          <span>{aside}</span>
          <Button size="sm" variant="ghost" onClick={onShowAside}>
            Show it
          </Button>
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-end gap-4">
        <div className="relative isolate shrink-0">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -inset-12 -z-10"
            style={{
              background: `radial-gradient(closest-side, color-mix(in srgb, var(--color-${coverFor(projectId, name).hue}) 12%, transparent), transparent)`
            }}
          />
          <Cover projectId={projectId} name={name} size={compact ? 96 : 160} />
        </div>
        <button onClick={onOpen} className="min-w-0 text-left text-sm text-fg-2 hover:text-fg-1">
          {taskTitle}
          <span className="mt-1 block">{name}</span>
        </button>
      </div>
      <h3 className="now-title" style={{ viewTransitionName: 'now-title' }}>
        {stepTitle}
      </h3>
      {reason && <p className="mt-2 text-sm text-fg-2">{reason}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-fg-2">
        <span className="meta tabular-nums">{minutes} min</span>
        <DifficultyTag difficulty={difficulty} />
        {item && (
          <span className="meta">
            {carried ? 'from ' : ''}
            {dayLabel(item.scheduledDate || item.deadline)}
          </span>
        )}
      </div>
      {item && (
        <div className="pt-3">
          <Scrubber stepKey={queueKey(item)} estimateMinutes={item.timeEstimate} />
        </div>
      )}
      <div className="mt-3 flex items-center justify-center gap-5">
        <Button
          ref={notThisRef}
          variant="ghost"
          leadingIcon={SkipForward}
          disabled={saving || splitting || !item}
          aria-keyshortcuts="S"
          title="Not this (S)"
          onClick={onNotThis}
        >
          Not this
        </Button>
        <PlayButton size={64} label="Start in Focus (Space)" onClick={onStart} />
        <Button
          variant="secondary"
          leadingIcon={Check}
          loading={saving}
          disabled={!item}
          onClick={onDone}
        >
          Done
        </Button>
      </div>
      {notice && (
        <p role="status" className="mt-3 text-center text-sm text-fg-2">
          {notice}
        </p>
      )}
      {reasons && (
        <SkipReasons
          prompt={reasons}
          onReason={(reason) => void whatNextStore.setReason(reason)}
          onTooBig={() => void whatNextStore.tooBig()}
          onBringBack={() => whatNextStore.bringBack()}
        />
      )}
    </>
  )
}

function CardEmpty({
  wn,
  projectCount,
  mood,
  onNavigate
}: {
  wn: WhatNextSnapshot
  projectCount: number | null
  mood: 'all' | 'lazy' | 'normal' | 'motivated'
  onNavigate: NavigationProps['onNavigate']
}): JSX.Element {
  const queue = useQueue()
  const empty = wn.result?.empty
  const noItems = projectCount === 0
  const waiting = wn.proxy.status === 'down'
  const preparing = wn.planBusy || empty === 'no-steps' || empty === null
  if (empty === 'mood' && mood !== 'all') {
    const word = mood === 'lazy' ? 'easy' : mood === 'normal' ? 'medium' : 'hard'
    return (
      <EmptyState
        icon={Disc3}
        title={`No ${word} steps queued.`}
        description="Switch mood or play what's next."
        action={<Button onClick={() => queueStore.setMood('all')}>Play what’s next</Button>}
      />
    )
  }
  if (empty === 'no-deadlines') {
    return (
      <EmptyState
        icon={Disc3}
        title="Nothing's due soon"
        description="None of your active items has a deadline coming up. Pick another energy, or enjoy the space."
        action={<Button onClick={() => whatNextStore.setChip('anything')}>Show anything</Button>}
      />
    )
  }
  if (empty === 'nothing-different') {
    return (
      <EmptyState
        icon={Disc3}
        title="Nothing different left today"
        description="You've worked on or skipped everything else today. A break counts too."
        action={
          <Button onClick={() => void whatNextStore.restoreSkips()}>Show skipped again</Button>
        }
      />
    )
  }
  if (empty === 'no-light') {
    return (
      <EmptyState
        icon={Disc3}
        title="No light steps right now"
        description="Press Not this, then Too big, on any step to get a smaller one."
        action={<Button onClick={() => whatNextStore.setChip('anything')}>Show anything</Button>}
      />
    )
  }
  if (empty === 'all-skipped') {
    return (
      <EmptyState
        icon={Disc3}
        title="That's everything for now"
        description="You skipped the rest for today. They'll be back tomorrow."
        action={
          <Button onClick={() => void whatNextStore.restoreSkips()}>Show skipped again</Button>
        }
      />
    )
  }
  if (noItems) {
    return (
      <EmptyState
        icon={Disc3}
        title="Nothing playing yet"
        description="Want me to look through your folders for courses and projects? I only read names and dates."
        action={<Button onClick={() => onNavigate({ name: 'items' })}>Find your items</Button>}
      />
    )
  }
  if (waiting) {
    return (
      <EmptyState
        icon={Disc3}
        title="Your next steps are waiting on the AI connection"
        description="Background prep is paused until CLIProxyAPI is back. Anything you've already planned still works."
        action={<Button onClick={() => onNavigate({ name: 'library' })}>Open Library</Button>}
      />
    )
  }
  if (preparing) {
    const first = queue.nextSteps[0]?.projectId ?? queue.all[0]?.projectId
    return (
      <EmptyState
        icon={Disc3}
        title="Getting your next steps ready"
        description="I'm reading your items. The first time takes a minute or two."
        action={
          <Button
            onClick={() =>
              onNavigate(first ? { name: 'coach', projectId: first } : { name: 'library' })
            }
          >
            Plan one with the coach
          </Button>
        }
      />
    )
  }
  return (
    <EmptyState
      icon={Disc3}
      title="Queue’s empty."
      description="Plan your next task with the coach."
      action={<Button onClick={() => onNavigate({ name: 'library' })}>New task</Button>}
    />
  )
}
