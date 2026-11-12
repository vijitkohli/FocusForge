// src/renderer/src/lib/whatNextStore.ts
// Drives the queue front from the deterministic picker. The card has no queue
// of its own: the pick is queue.current, via playNext(), and a listener
// re-applies it inside publish() so Done advances in Now and in Focus.
import { useEffect, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { localDateKey } from '../../../common/schedule'
import type { ItemNextStep } from '../../../common/nextSteps'
import type { UpcomingSubtask } from '../../../common/types'
import {
  ENERGY_CHIPS,
  toRankable,
  type EnergyChip,
  type ProxyHealthView,
  type SkipEvent,
  type SkipReason,
  type WhatNextSignals
} from '../../../common/whatNext'
import { dueDays, pickNext, type PickResult } from './whatNext'
import { queueKey, queueStore, type QueueIdentity, type QueueSnapshot } from './queue'
import { todayPlanStore } from './todayPlan'

const CHIP_KEY = 'focusforge.whatnext.chip'
const LAST_KEY = 'focusforge.whatnext.last'
const REASONS_MS = 8000

export interface LastKnownCard {
  key: string
  stepTitle: string
  itemName: string
  taskTitle: string
  projectId: string
  reason: string
  minutes: number
  difficulty: 'easy' | 'medium' | 'hard'
}

export interface SkipPrompt {
  at: string
  item: QueueIdentity
  title: string
}

export interface WhatNextSnapshot {
  chip: EnergyChip
  result: PickResult | null
  userPicked: boolean
  pinnedKey: string | null
  reason: string
  reasons: SkipPrompt | null
  splitting: boolean
  notice: string | null
  proxy: ProxyHealthView
  planBusy: boolean
  signalsLoaded: boolean
  lastKnown: LastKnownCard | null
}

interface State {
  chip: EnergyChip
  signals: WhatNextSignals | null
  signalsLoaded: boolean
  lastDone?: { key: string; itemId: string; taskId: string; title: string; at: string }
  appliedKey: string | null
  pinnedKey: string | null
  userPicked: boolean
  result: PickResult | null
  reason: string
  reasons: SkipPrompt | null
  splitting: boolean
  notice: string | null
  proxy: ProxyHealthView
  planBusy: boolean
  lastKnown: LastKnownCard | null
}

const listeners = new Set<() => void>()
let chipSync = false
let applying = false
let holders = 0
let stopMounted: (() => void) | null = null
let reasonsTimer: ReturnType<typeof setTimeout> | null = null

function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // The card still works for this session.
  }
}

function loadChip(): EnergyChip {
  try {
    const raw = JSON.parse(storageGet(CHIP_KEY) || '') as { date?: string; chip?: string }
    if (raw.date === localDateKey(new Date()) && ENERGY_CHIPS.includes(raw.chip as EnergyChip)) {
      return raw.chip as EnergyChip
    }
  } catch {
    // Default below.
  }
  return 'anything'
}

function saveChip(chip: EnergyChip): void {
  storageSet(CHIP_KEY, JSON.stringify({ date: localDateKey(new Date()), chip }))
}

function readLast(): LastKnownCard | null {
  try {
    const raw = JSON.parse(storageGet(LAST_KEY) || '') as LastKnownCard
    if (raw && typeof raw.key === 'string' && typeof raw.stepTitle === 'string') return raw
  } catch {
    // No last card.
  }
  return null
}

let state: State = {
  chip: loadChip(),
  signals: null,
  signalsLoaded: false,
  appliedKey: null,
  pinnedKey: null,
  userPicked: false,
  result: null,
  reason: '',
  reasons: null,
  splitting: false,
  notice: null,
  proxy: { status: 'unknown', checkedAt: null },
  planBusy: false,
  lastKnown: readLast()
}

let snapshot: WhatNextSnapshot = toSnapshot()

function toSnapshot(): WhatNextSnapshot {
  return {
    chip: state.chip,
    result: state.result,
    userPicked: state.userPicked,
    pinnedKey: state.pinnedKey,
    reason: state.reason,
    reasons: state.reasons,
    splitting: state.splitting,
    notice: state.notice,
    proxy: state.proxy,
    planBusy: state.planBusy,
    signalsLoaded: state.signalsLoaded,
    lastKnown: state.lastKnown
  }
}

function emit(): void {
  snapshot = toSnapshot()
  listeners.forEach((listener) => listener())
}

function clearReasonsTimer(): void {
  if (reasonsTimer) clearTimeout(reasonsTimer)
  reasonsTimer = null
}

function armReasonsTimer(): void {
  clearReasonsTimer()
  reasonsTimer = setTimeout(() => {
    reasonsTimer = null
    if (!state.reasons) return
    state = { ...state, reasons: null }
    emit()
  }, REASONS_MS)
}

function signalsNow(): WhatNextSignals {
  return state.signals ?? { date: localDateKey(new Date()), dues: [], starts: {}, skipsToday: [] }
}

function planKeys(): Set<string> {
  const plan = todayPlanStore.getSnapshot().plan
  if (!plan || plan.date !== localDateKey(new Date())) return new Set()
  return new Set(plan.items.map((item) => item.key))
}

/** One step per task from the queue, when Phase 5's getNextSteps isn't there yet. */
function derivedSteps(q: QueueSnapshot): ItemNextStep[] {
  const seen = new Set<string>()
  const out: ItemNextStep[] = []
  for (const item of q.all) {
    const id = `${item.projectId}\0${item.taskId}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      projectId: item.projectId,
      itemKind: 'deadline',
      category: 'Learning',
      taskId: item.taskId,
      taskTitle: item.taskTitle,
      subtaskId: item.subtaskId,
      title: item.subtaskTitle,
      ...(item.timeEstimate ? { minutes: item.timeEstimate } : {}),
      difficulty: item.difficulty,
      deadline: item.deadline,
      deadlineKind: 'hard',
      needsPlan: false,
      itemName: item.projectName,
      ...(item.scheduledDate ? { scheduledDate: item.scheduledDate } : {})
    })
  }
  return out
}

function stepsOf(q: QueueSnapshot): ItemNextStep[] {
  if (typeof window !== 'undefined' && typeof window.api?.getNextSteps === 'function') {
    return [...q.nextSteps]
  }
  return derivedSteps(q)
}

function findItem(q: QueueSnapshot, key: string): UpcomingSubtask | undefined {
  return q.all.find((item) => queueKey(item) === key)
}

function remember(item: UpcomingSubtask, reason: string): void {
  const card: LastKnownCard = {
    key: queueKey(item),
    stepTitle: item.subtaskTitle,
    itemName: item.projectName,
    taskTitle: item.taskTitle,
    projectId: item.projectId,
    reason,
    minutes: item.timeEstimate || 15,
    difficulty: item.difficulty
  }
  state = { ...state, lastKnown: card }
  storageSet(LAST_KEY, JSON.stringify(card))
}

function shownReason(
  userPicked: boolean,
  pinnedKey: string | null,
  result: PickResult | null
): string {
  if (userPicked) return 'You picked this one.'
  if (pinnedKey && result) {
    const hit = [result.pick, ...result.rest].find((p) => p?.input.key === pinnedKey)
    if (hit) return hit.reason
  }
  return result?.pick?.reason ?? ''
}

function pin(item: QueueIdentity): void {
  const key = queueKey(item)
  applying = true
  state = { ...state, appliedKey: key, pinnedKey: state.pinnedKey }
  queueStore.playNext(item)
  applying = false
}

function syncChipFromMood(): void {
  if (chipSync) return
  const mood = queueStore.getSnapshot().mood
  if (state.chip === 'light' && mood !== 'lazy') {
    state = { ...state, chip: 'anything' }
    saveChip('anything')
  } else if (mood === 'lazy' && state.chip !== 'light') {
    state = { ...state, chip: 'light' }
    saveChip('light')
  }
}

function recompute(): void {
  if (applying) return
  const q = queueStore.getSnapshot()
  syncChipFromMood()
  if (!q.loaded) {
    emit()
    return
  }
  const now = new Date()
  const inputs = toRankable(stepsOf(q), signalsNow(), now)
  const result = pickNext(inputs, {
    now,
    chip: state.chip,
    mood: q.mood,
    eligibleKeys: new Set(q.items.map(queueKey)),
    skipsToday: signalsNow().skipsToday,
    lastDone: state.lastDone,
    todayPlanKeys: planKeys()
  })

  const userOwned =
    !!q.frontOverride && q.frontOverride !== state.appliedKey && q.frontOverride !== state.pinnedKey
  if (userOwned) {
    state = {
      ...state,
      result,
      userPicked: true,
      pinnedKey: null,
      reason: 'You picked this one.'
    }
    if (q.current) remember(q.current, 'You picked this one.')
    emit()
    return
  }

  if (state.pinnedKey) {
    if (q.loading) {
      state = { ...state, result, userPicked: false }
      emit()
      return
    }
    const pinned = findItem(q, state.pinnedKey)
    if (!pinned) {
      state = { ...state, pinnedKey: null }
    } else {
      if (q.frontOverride !== state.pinnedKey) {
        applying = true
        state = { ...state, appliedKey: state.pinnedKey }
        queueStore.playNext(pinned)
        applying = false
      }
      const reason = shownReason(false, state.pinnedKey, result)
      state = { ...state, result, userPicked: false, reason, appliedKey: state.pinnedKey }
      remember(pinned, reason)
      emit()
      return
    }
  }

  const pick = result.pick
  if (!pick) {
    if (q.frontOverride && q.frontOverride === state.appliedKey) {
      applying = true
      state = { ...state, appliedKey: null }
      queueStore.clearOverride()
      applying = false
    }
    state = { ...state, result, userPicked: false, reason: '', appliedKey: state.appliedKey }
    emit()
    return
  }

  const item = findItem(q, pick.input.key)
  if (!item) {
    state = { ...state, result, userPicked: false, reason: pick.reason }
    emit()
    return
  }
  if (q.frontOverride !== pick.input.key) {
    applying = true
    state = { ...state, appliedKey: pick.input.key }
    queueStore.playNext(item)
    applying = false
  }
  state = {
    ...state,
    result,
    userPicked: false,
    reason: pick.reason,
    appliedKey: pick.input.key
  }
  remember(item, pick.reason)
  emit()
}

function onQueue(): void {
  recompute()
}

function matchingStep(item: UpcomingSubtask): ItemNextStep | undefined {
  return queueStore
    .getSnapshot()
    .nextSteps.find(
      (s) =>
        s.projectId === item.projectId && s.taskId === item.taskId && s.subtaskId === item.subtaskId
    )
}

function buildSkip(item: UpcomingSubtask, reason: SkipReason): SkipEvent {
  const step = matchingStep(item)
  const now = new Date()
  const key = queueKey(item)
  const ranked = state.result?.pick?.input.key === key ? state.result.pick.input : null
  return {
    at: now.toISOString(),
    date: localDateKey(now),
    hour: now.getHours(),
    itemId: item.projectId,
    taskId: item.taskId,
    subtaskId: item.subtaskId,
    reason,
    chip: state.chip,
    mood: queueStore.getSnapshot().mood,
    itemKind: step?.itemKind ?? 'deadline',
    category: step?.category ?? 'Learning',
    difficulty: item.difficulty,
    minutes: item.timeEstimate ?? step?.minutes ?? 15,
    dueDays: ranked ? dueDays(ranked.due?.date ?? null, now) : null,
    dueConfidence: ranked?.due?.confidence ?? null,
    isLooseEnd: ranked?.isLooseEnd ?? (step?.taskAuto === 'loose-ends' || step?.origin === 'gap'),
    rank: 0
  }
}

function rememberSkip(event: SkipEvent): void {
  const signals = signalsNow()
  state = {
    ...state,
    signals: {
      ...signals,
      skipsToday: signals.skipsToday.filter((e) => e.at !== event.at).concat(event)
    },
    signalsLoaded: true
  }
}

function patchSkip(at: string, reason: SkipReason, undone?: boolean): void {
  const signals = signalsNow()
  state = {
    ...state,
    signals: {
      ...signals,
      skipsToday: signals.skipsToday.map((e) =>
        e.at === at ? { ...e, reason, ...(undone ? { undone: true } : {}) } : e
      )
    }
  }
}

function withCardTransition(run: () => void): void {
  const reduce =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const start =
    typeof document !== 'undefined'
      ? (document as Document & { startViewTransition?: (cb: () => void) => void })
          .startViewTransition
      : undefined
  if (!start || reduce) {
    run()
    return
  }
  start(() => flushSync(run))
}

async function refreshSignals(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.api?.getWhatNextSignals !== 'function') return
  try {
    const signals = await window.api.getWhatNextSignals()
    state = { ...state, signals, signalsLoaded: true }
    recompute()
  } catch {
    emit()
  }
}

async function refreshProxy(): Promise<void> {
  if (typeof window.api?.getProxyHealth !== 'function') return
  try {
    state = { ...state, proxy: await window.api.getProxyHealth() }
    emit()
  } catch {
    // The dot stays unknown.
  }
}

async function refreshPlan(): Promise<void> {
  if (typeof window.api?.getPlanQueueStatus !== 'function') return
  try {
    const status = await window.api.getPlanQueueStatus()
    state = {
      ...state,
      planBusy: !!status && (status.state === 'running' || status.queued > 0)
    }
    emit()
  } catch {
    // Empty states fall back to the proxy dot.
  }
}

function mount(): () => void {
  const offs: (() => void)[] = [
    queueStore.subscribe(onQueue),
    todayPlanStore.subscribe(() => recompute())
  ]
  if (typeof window !== 'undefined' && window.api) {
    if (window.api.onTasksChanged) offs.push(window.api.onTasksChanged(() => void refreshSignals()))
    if (window.api.onDigestUpdated) {
      offs.push(
        window.api.onDigestUpdated(() => {
          void queueStore.refresh().catch(() => {})
          void refreshSignals()
        })
      )
    }
    if (window.api.onProxyHealth) {
      offs.push(
        window.api.onProxyHealth((health) => {
          state = { ...state, proxy: health }
          emit()
        })
      )
    }
    if (window.api.onPlanStatus) offs.push(window.api.onPlanStatus(() => void refreshPlan()))
  }
  const interval = setInterval(() => void refreshSignals(), 5 * 60_000)
  void refreshSignals()
  void refreshProxy()
  void refreshPlan()
  onQueue()
  return () => {
    clearInterval(interval)
    offs.forEach((off) => off())
  }
}

function currentItem(): UpcomingSubtask | null {
  return queueStore.getSnapshot().current
}

export const whatNextStore = {
  getSnapshot(): WhatNextSnapshot {
    return snapshot
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Idempotent. App holds one for the whole session, including Focus. */
  start(): () => void {
    holders += 1
    if (holders === 1) stopMounted = mount()
    let released = false
    return () => {
      if (released) return
      released = true
      holders -= 1
      if (holders === 0) {
        stopMounted?.()
        stopMounted = null
      }
    }
  },
  setChip(chip: EnergyChip): void {
    chipSync = true
    clearReasonsTimer()
    state = { ...state, chip, reasons: null, pinnedKey: null, notice: null }
    saveChip(chip)
    const mood = queueStore.getSnapshot().mood
    if (chip === 'light' && mood !== 'lazy') queueStore.setMood('lazy')
    else if (chip !== 'light' && mood === 'lazy') queueStore.setMood('all')
    chipSync = false
    recompute()
  },
  setNotice(notice: string | null): void {
    state = { ...state, notice }
    emit()
  },
  dismissReasons(): void {
    if (!state.reasons) return
    clearReasonsTimer()
    state = { ...state, reasons: null }
    emit()
  },
  notThis(): void {
    const item = currentItem()
    if (!item || state.splitting) return
    clearReasonsTimer()
    const event = buildSkip(item, 'none')
    rememberSkip(event)
    state = {
      ...state,
      reasons: { at: event.at, item, title: item.subtaskTitle },
      notice: null,
      pinnedKey: null
    }
    emit()
    try {
      withCardTransition(() => queueStore.skip(item))
    } catch {
      queueStore.skip(item)
    }
    void window.api?.recordSkip?.(event)
    recompute()
    armReasonsTimer()
  },
  async setReason(reason: Exclude<SkipReason, 'none'>): Promise<void> {
    const row = state.reasons
    if (!row || reason === 'too-big') return
    patchSkip(row.at, reason)
    void window.api?.updateSkipReason?.(row.at, reason)
    clearReasonsTimer()
    state = { ...state, reasons: null, notice: 'Got it.' }
    emit()
    if (reason === 'tired') recompute()
  },
  async tooBig(): Promise<void> {
    const row = state.reasons
    const item = row
      ? (findItem(queueStore.getSnapshot(), queueKey(row.item)) ?? currentItem())
      : currentItem()
    if (!item || state.splitting) return
    let at = row?.at
    if (!at) {
      const event = buildSkip(item, 'too-big')
      at = event.at
      rememberSkip(event)
      queueStore.skip(item)
      void window.api?.recordSkip?.(event)
    } else {
      patchSkip(at, 'too-big')
      void window.api?.updateSkipReason?.(at, 'too-big')
    }
    const title = row?.title ?? item.subtaskTitle
    clearReasonsTimer()
    state = {
      ...state,
      splitting: true,
      reasons: null,
      pinnedKey: null,
      notice: `Making “${title}” smaller…`
    }
    emit()
    const restore = (message: string): void => {
      patchSkip(at as string, 'none', true)
      void window.api?.updateSkipReason?.(at, 'none', true)
      state = { ...state, splitting: false, pinnedKey: queueKey(item), notice: message }
      pin(item)
      emit()
    }
    try {
      const result = await window.api.splitStep(item.projectId, item.taskId, item.subtaskId)
      const first = result.created?.[0]
      if (!result.success || result.cancelled || !first) {
        restore("Couldn't split that one right now. It's back in your queue.")
        return
      }
      const next = { projectId: item.projectId, taskId: item.taskId, subtaskId: first.id }
      const n = result.created?.length ?? 1
      state = {
        ...state,
        splitting: false,
        pinnedKey: queueKey(next),
        appliedKey: queueKey(next),
        notice: `Split into ${n} smaller ${n === 1 ? 'step' : 'steps'}.`
      }
      emit()
      await queueStore.refreshWithFront(next)
    } catch {
      restore("Couldn't split that one right now. It's back in your queue.")
    }
  },
  bringBack(): void {
    const row = state.reasons
    if (!row) return
    clearReasonsTimer()
    patchSkip(row.at, 'none', true)
    void window.api?.updateSkipReason?.(row.at, 'none', true)
    state = { ...state, reasons: null, notice: null, pinnedKey: queueKey(row.item) }
    pin(row.item)
    recompute()
  },
  async restoreSkips(): Promise<void> {
    const signals = signalsNow()
    state = {
      ...state,
      signals: { ...signals, skipsToday: signals.skipsToday.map((e) => ({ ...e, undone: true })) },
      reasons: null,
      pinnedKey: null,
      notice: null
    }
    clearReasonsTimer()
    queueStore.clearSkips()
    void window.api?.clearTodaySkips?.()
    recompute()
  },
  markStart(itemId: string): void {
    void window.api?.markTouched?.(itemId)
    const iso = new Date().toISOString()
    const signals = state.signals
    if (!signals) return
    state = { ...state, signals: { ...signals, starts: { ...signals.starts, [itemId]: iso } } }
    recompute()
  },
  noteDone(item: UpcomingSubtask): void {
    clearReasonsTimer()
    state = {
      ...state,
      lastDone: {
        key: queueKey(item),
        itemId: item.projectId,
        taskId: item.taskId,
        title: item.subtaskTitle,
        at: new Date().toISOString()
      },
      reasons: null,
      pinnedKey: null,
      notice: null
    }
    emit()
  }
}

export function useWhatNext(): WhatNextSnapshot {
  const value = useSyncExternalStore(
    whatNextStore.subscribe,
    whatNextStore.getSnapshot,
    whatNextStore.getSnapshot
  )
  useEffect(() => whatNextStore.start(), [])
  return value
}
