import { useCallback, useEffect, useReducer, useRef, useState, type JSX } from 'react'
import { ChevronRight, FolderPlus, FolderSearch, Plus, RefreshCw, Sprout } from 'lucide-react'
import type { DiscoveryResult } from 'src/common/discovery'
import { CATEGORIES, type ItemCategory } from 'src/common/workstreams'
import { ItemRow } from '../components/ItemRow'
import {
  approvalReducer,
  buildApplyRequest,
  footerCounts,
  groupRows,
  initApproval,
  type ApprovalState,
  type CategoryGroup,
  type ItemRowState
} from '../lib/itemApproval'
import type { NavigationProps } from '../shell/navigation'
import { Button, EmptyState, Input, Select, Skeleton } from '../ui'

const EMPTY: ApprovalState = {
  rows: [],
  hidden: [],
  dismissedKeys: [],
  notice: null,
  manualSeq: 0
}

type Phase = 'loading' | 'ready' | 'error'

function Disclosure({
  id,
  label,
  open,
  onToggle,
  children
}: {
  id: string
  label: string
  open: boolean
  onToggle: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <div className="space-y-2">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        leadingIcon={ChevronRight}
        className={
          open ? '[&_svg]:rotate-90 [&_svg]:transition-transform' : '[&_svg]:transition-transform'
        }
      >
        {label}
      </Button>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  )
}

function AddNameForm({
  label,
  category,
  showCategory,
  onAdd,
  onCancel
}: {
  label: string
  category: ItemCategory
  showCategory: boolean
  onAdd: (name: string, category: ItemCategory) => void
  onCancel: () => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [cat, setCat] = useState<ItemCategory>(category)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!name.trim()) return
        onAdd(name, cat)
        setName('')
      }}
    >
      <div className="min-w-0 flex-1 sm:max-w-72">
        <Input
          ref={ref}
          label={label}
          value={name}
          placeholder={showCategory ? 'For example, Driving lessons' : 'For example, Reading'}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onCancel()
            }
          }}
        />
      </div>
      {showCategory && (
        <div className="w-40">
          <Select
            label="Category"
            value={cat}
            onChange={(event) => setCat(event.target.value as ItemCategory)}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
      )}
      <Button type="submit" variant="primary" disabled={!name.trim()}>
        Add
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  )
}

export function Items({ onNavigate }: Pick<NavigationProps, 'onNavigate'>): JSX.Element {
  const [state, dispatch] = useReducer(approvalReducer, EMPTY)
  const [phase, setPhase] = useState<Phase>('loading')
  const [result, setResult] = useState<DiscoveryResult | null>(null)
  const [firstRun, setFirstRun] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedLine, setSavedLine] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [adding, setAdding] = useState<{ category: ItemCategory; life: boolean } | null>(null)
  const [vaultError, setVaultError] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const run = useRef(0)
  const savingRef = useRef(false)

  const discover = useCallback(async (): Promise<void> => {
    const id = ++run.current
    setPhase('loading')
    setSaveError(null)
    try {
      const settings = await window.api.getSettings()
      const first = settings.discoveryCompletedAt === null
      const found = await window.api.discoverWorkstreams()
      if (id !== run.current) return
      setFirstRun(first)
      setResult(found)
      dispatch({ type: 'reset', state: initApproval(found, { firstRun: first }) })
      setPhase('ready')
      setAnnounce(
        `Found ${found.candidates.length} ${found.candidates.length === 1 ? 'suggestion' : 'suggestions'}`
      )
    } catch {
      if (id === run.current) setPhase('error')
    }
  }, [])

  useEffect(() => {
    const runs = run
    void discover()
    return () => {
      // Drops the result of a run that finishes after this view closes.
      runs.current++
    }
  }, [discover])

  useEffect(() => {
    if (phase === 'ready') headingRef.current?.focus()
  }, [phase])

  const save = useCallback(async (): Promise<void> => {
    if (savingRef.current || phase !== 'ready') return
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      const res = await window.api.applyDiscovery(buildApplyRequest(state))
      if (!res.success) {
        setSaveError(res.error ?? "I couldn't save your items. Nothing was deleted; try again.")
        return
      }
      window.dispatchEvent(new CustomEvent('focusforge:projects-changed'))
      setSavedLine(
        res.error
          ? `${res.error} All set. Your next step is on Now Playing.`
          : 'All set. Your next step is on Now Playing.'
      )
      window.setTimeout(() => onNavigate({ name: 'now' }), res.error ? 2400 : 1200)
    } catch {
      setSaveError("I couldn't save your items. Nothing was deleted; try again.")
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [state, phase, onNavigate])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && event.metaKey && !event.defaultPrevented) {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save])

  const notNow = async (): Promise<void> => {
    try {
      await window.api.saveSettings({ discoveryDismissedAt: new Date().toISOString() })
    } catch {
      // Still leave; the screen comes back next launch.
    }
    onNavigate({ name: 'now' })
  }

  const addFromDialog = async (): Promise<void> => {
    try {
      const picked = await window.api.addSourceViaDialog()
      if (!picked) return
      if ('error' in picked) dispatch({ type: 'notice', message: picked.error })
      else dispatch({ type: 'add', candidate: picked.candidate })
    } catch {
      dispatch({ type: 'notice', message: "I couldn't open that. Try another folder." })
    }
  }

  const attachTo = async (key: string): Promise<void> => {
    try {
      const picked = await window.api.addSourceViaDialog()
      if (!picked) return
      if ('error' in picked) {
        dispatch({ type: 'notice', key, message: picked.error })
        return
      }
      const source = picked.candidate.sources[0]
      if (source) dispatch({ type: 'attachSource', key, source: { ...source, match: 'user' } })
    } catch {
      dispatch({ type: 'notice', key, message: "I couldn't open that. Try another folder." })
    }
  }

  const chooseVault = async (): Promise<void> => {
    setVaultError(null)
    try {
      const picked = await window.api.chooseVaultFolder()
      if (!picked) return
      if ('error' in picked) setVaultError(picked.error)
      else void discover()
    } catch {
      setVaultError("I couldn't open that folder. Try again.")
    }
  }

  const groups = groupRows(state.rows)
  const counts = footerCounts(state)
  const busy = saving || !!savedLine
  const rowNotice = (row: ItemRowState): string | undefined =>
    state.notice?.key === row.key ? state.notice.message : undefined
  const globalNotice =
    state.notice && !state.rows.some((r) => r.key === state.notice?.key)
      ? state.notice.message
      : null
  const rootLabels = (result?.roots ?? []).map((r) => r.label)
  const where = [...rootLabels, 'your vault'].join(', ').replace(/, ([^,]*)$/, ' and $1')

  const renderRows = (rows: ItemRowState[]): JSX.Element => (
    <ul role="list" className="space-y-2">
      {rows.map((row) => (
        <ItemRow
          key={row.key}
          row={row}
          dispatch={dispatch}
          disabled={busy}
          notice={rowNotice(row)}
          onAttachSource={(key) => void attachTo(key)}
        />
      ))}
    </ul>
  )

  const renderGroup = (group: CategoryGroup, index: number): JSX.Element => {
    const headingId = `items-group-${group.category.toLowerCase()}`
    const empty = group.main.length + group.also.length + group.quiet.length === 0
    const alsoKey = `${group.category}:also`
    const quietKey = `${group.category}:quiet`
    const alsoOpen = open[alsoKey] ?? true
    const quietOpen = open[quietKey] ?? false
    const addingHere = adding?.category === group.category
    return (
      <section
        key={group.category}
        aria-labelledby={headingId}
        data-category={group.category}
        className="space-y-3"
      >
        <h2
          id={headingId}
          ref={index === 0 ? headingRef : undefined}
          tabIndex={-1}
          className="text-lg font-bold tracking-[-0.01em] text-fg-1"
          // Focus lands here after loading (tabIndex -1, not a tab stop); the
          // global unlayered :focus-visible ring would otherwise frame it.
          style={{ outline: 'none' }}
        >
          {group.category} · {group.activeCount} active
        </h2>
        {group.category === 'Life' && (
          <div className="space-y-3">
            <p className="max-w-[72ch] text-sm leading-[1.55] text-fg-2">
              Life items you add live in FocusForge/Life in your vault. Your own Life folder stays
              closed.
            </p>
            {group.main.length > 0 && renderRows(group.main)}
            {addingHere ? (
              <AddNameForm
                label="Name for the new Life item"
                category="Life"
                showCategory={false}
                onAdd={(name) => {
                  dispatch({ type: 'addManual', name, category: 'Life' })
                  setAdding(null)
                }}
                onCancel={() => setAdding(null)}
              />
            ) : (
              <Button
                leadingIcon={Sprout}
                disabled={busy}
                onClick={() => setAdding({ category: 'Life', life: true })}
              >
                Add a Life item
              </Button>
            )}
          </div>
        )}
        {group.category !== 'Life' && empty && group.category === 'Career' && !addingHere && (
          <EmptyState
            icon={FolderSearch}
            title="Nothing here yet"
            description="Add notes to your vault's Career folder and I'll pick them up, or add an item now."
            className="rounded-md border border-dashed border-line py-8"
            action={
              <Button
                disabled={busy}
                onClick={() => setAdding({ category: 'Career', life: false })}
              >
                Add an item
              </Button>
            }
          />
        )}
        {group.category !== 'Life' && empty && group.category !== 'Career' && (
          <p className="text-sm text-fg-3">Nothing found here.</p>
        )}
        {group.category !== 'Life' && addingHere && (
          <AddNameForm
            label="Name for the new item"
            category={group.category}
            showCategory
            onAdd={(name, category) => {
              dispatch({ type: 'addManual', name, category })
              setAdding(null)
            }}
            onCancel={() => setAdding(null)}
          />
        )}
        {group.category !== 'Life' && group.main.length > 0 && renderRows(group.main)}
        {group.also.length > 0 && (
          <Disclosure
            id={`${headingId}-also`}
            label={`Also found (${group.also.length})`}
            open={alsoOpen}
            onToggle={() => setOpen((o) => ({ ...o, [alsoKey]: !alsoOpen }))}
          >
            {renderRows(group.also)}
          </Disclosure>
        )}
        {group.quiet.length > 0 && (
          <Disclosure
            id={`${headingId}-quiet`}
            label={`Quiet for a while (${group.quiet.length})`}
            open={quietOpen}
            onToggle={() => setOpen((o) => ({ ...o, [quietKey]: !quietOpen }))}
          >
            {renderRows(group.quiet)}
          </Disclosure>
        )}
      </section>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-8">
      <header className="space-y-2">
        <h1 className="text-[32px] leading-[1.15] font-[750] tracking-[-0.02em]">
          Here&apos;s what I found
        </h1>
        <p className="max-w-[72ch] text-sm leading-[1.55] text-fg-2">
          I looked at folder names and dates in {where}, not what&apos;s inside. You can change any
          of this later.
        </p>
        <p className="max-w-[72ch] text-sm leading-[1.55] text-fg-1">
          {firstRun
            ? "I'm starting you with five. Tick anything else you want me to follow."
            : 'Tick anything else you want me to follow.'}
        </p>
        <p className="text-[12.5px] text-fg-3">Your vault&apos;s Life folder stays closed.</p>
      </header>

      <p role="status" className="sr-only">
        {announce}
      </p>

      {phase === 'loading' && (
        <div role="status" aria-busy="true" className="space-y-4">
          <div className="flex items-center gap-3">
            <p className="text-sm text-fg-2">Looking through your folders…</p>
            <Button size="sm" variant="ghost" onClick={() => void window.api.cancelDiscovery()}>
              Stop
            </Button>
          </div>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 rounded-md border border-line p-4">
              <Skeleton width={40} height={40} />
              <div className="flex-1 space-y-2">
                <Skeleton width="40%" height={16} />
                <Skeleton width="60%" height={12} />
              </div>
            </div>
          ))}
        </div>
      )}

      {phase === 'error' && (
        <div role="alert" className="space-y-3 rounded-md bg-bg-2 p-4">
          <p className="text-sm text-fg-1">
            I couldn&apos;t look through your folders just now. Nothing was changed.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void discover()}>Try again</Button>
            {firstRun && (
              <Button variant="ghost" onClick={() => void notNow()}>
                Not now
              </Button>
            )}
          </div>
        </div>
      )}

      {phase === 'ready' && result && (
        <>
          {!result.vault.valid && (
            <div className="space-y-3 rounded-md bg-bg-2 p-4">
              <p className="text-sm text-fg-1">I couldn&apos;t find your Obsidian vault.</p>
              <Button leadingIcon={FolderSearch} onClick={() => void chooseVault()}>
                Choose vault folder
              </Button>
              {vaultError && (
                <p role="alert" className="text-sm text-medium">
                  {vaultError}
                </p>
              )}
            </div>
          )}
          {result.warnings.length > 0 && (
            <ul role="status" className="space-y-1 text-sm text-fg-3">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {globalNotice && (
            <p role="alert" className="text-sm text-medium">
              {globalNotice}
            </p>
          )}

          {groups.map(renderGroup)}

          {!adding && (
            <div>
              <Button
                leadingIcon={Plus}
                disabled={busy}
                onClick={() => setAdding({ category: 'Learning', life: false })}
              >
                Add an item
              </Button>
            </div>
          )}

          {state.hidden.length > 0 && (
            <Disclosure
              id="items-hidden"
              label={`Hidden (${state.hidden.length})`}
              open={open.hidden ?? false}
              onToggle={() => setOpen((o) => ({ ...o, hidden: !(o.hidden ?? false) }))}
            >
              <ul role="list" className="space-y-1">
                {state.hidden.map((row) => (
                  <li key={row.key} className="flex items-center justify-between gap-3 py-1">
                    <span className="min-w-0 truncate text-sm text-fg-2">{row.name}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Restore ${row.name}`}
                      disabled={busy}
                      onClick={() => dispatch({ type: 'restore', key: row.key })}
                    >
                      Restore
                    </Button>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </>
      )}

      <footer className="sticky bottom-0 z-10 -mx-8 mt-auto flex flex-wrap items-center gap-2 border-t border-line bg-bg-1 px-8 py-4">
        <Button
          leadingIcon={FolderPlus}
          disabled={phase !== 'ready' || busy}
          onClick={() => void addFromDialog()}
        >
          Add a folder or note
        </Button>
        <Button
          variant="ghost"
          leadingIcon={RefreshCw}
          disabled={phase === 'loading' || busy}
          onClick={() => void discover()}
        >
          Look again
        </Button>
        {firstRun && (
          <Button variant="ghost" disabled={busy} onClick={() => void notNow()}>
            Not now
          </Button>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {saveError && (
            <p role="alert" className="text-sm text-hard">
              {saveError}
            </p>
          )}
          {savedLine && (
            <p role="status" className="text-sm text-easy">
              {savedLine}
            </p>
          )}
          <Button
            variant="primary"
            loading={saving}
            loadingLabel="Saving"
            disabled={phase !== 'ready' || !!savedLine}
            aria-keyshortcuts="Meta+Enter"
            onClick={() => void save()}
          >
            Save {counts.total} {counts.total === 1 ? 'item' : 'items'} · {counts.active} active
          </Button>
        </div>
      </footer>
    </div>
  )
}
