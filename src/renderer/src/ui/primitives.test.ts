import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Check, FolderOpen } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coverFor } from '../lib/cover'
import { Button } from './Button'
import { Checkbox } from './Checkbox'
import { Cover } from './Cover'
import { DateInput } from './DateInput'
import { DayLabel } from './DayLabel'
import { DifficultyTag } from './DifficultyTag'
import { Drawer } from './Drawer'
import { EmptyState } from './EmptyState'
import { IconButton } from './IconButton'
import { Input } from './Input'
import { Kbd } from './Kbd'
import { Menu } from './Menu'
import { PlayButton } from './PlayButton'
import { SegmentedControl } from './SegmentedControl'
import { Select } from './Select'
import { Skeleton } from './Skeleton'
import { Textarea } from './Textarea'
import { focusableElements, nextEnabledIndex, setRef, tabFocusTarget } from './internal'

const render = renderToStaticMarkup

afterEach(() => vi.unstubAllGlobals())

describe('primitive markup and standard HTML props', () => {
  it('renders date fields with a themed calendar button instead of the native indicator', () => {
    const markup = render(
      createElement(DateInput, {
        label: 'Due',
        value: '2026-10-20',
        onChange: () => {},
        pickerLabel: 'Open calendar for due date'
      })
    )
    expect(markup).toContain('type="date"')
    expect(markup).toContain('date-input')
    expect(markup).toContain('aria-label="Open calendar for due date"')
    expect(markup).toContain('type="button"')
    const disabled = render(
      createElement(DateInput, { 'aria-label': 'Deadline', disabled: true, readOnly: true })
    )
    expect(disabled.match(/disabled=""/g)).toHaveLength(2)
  })

  it('keeps button content in place while loading, disables submission, and announces busy state', () => {
    const markup = render(
      createElement(
        Button,
        {
          loading: true,
          variant: 'primary',
          leadingIcon: Check,
          name: 'save'
        },
        'Save'
      )
    )
    expect(markup).toContain('type="button"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('text-on-accent')
    expect(markup).toContain('opacity-0')
    expect(markup).toContain('Save')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('name="save"')
  })

  it('labels icon buttons and play/pause actions with accessible names and tooltips', () => {
    const icon = render(createElement(IconButton, { label: 'Mark done', icon: Check, size: 36 }))
    expect(icon).toContain('aria-label="Mark done"')
    expect(icon).toContain('title="Mark done"')
    for (const size of [36, 64, 80] as const) {
      const play = render(createElement(PlayButton, { playing: true, size }))
      expect(play).toContain('aria-label="Pause"')
      expect(play).toContain('title="Pause"')
      expect(play).toContain('text-on-accent')
    }
  })

  it('connects field labels and errors while retaining caller descriptions and native props', () => {
    const props = {
      id: 'title',
      label: 'Title',
      error: 'Required',
      required: true,
      'aria-describedby': 'hint',
      name: 'title'
    }
    for (const field of [
      createElement(Input, props),
      createElement(Textarea, props),
      createElement(Select, props)
    ]) {
      const markup = render(field)
      expect(markup).toContain('for="title"')
      expect(markup).toContain('aria-invalid="true"')
      expect(markup).toContain('aria-describedby="hint title-error"')
      expect(markup).toContain('id="title-error"')
      expect(markup).toContain('role="alert"')
      expect(markup).toContain('required=""')
      expect(markup).toContain('name="title"')
      expect(markup).toContain('border-hard')
      expect(markup).not.toContain('border-line-strong')
      expect(markup).not.toContain('focus:border-accent')
    }
    const input = render(createElement(Input, { 'aria-invalid': true, 'aria-label': 'Name' }))
    expect(input).toContain('aria-invalid="true"')
    expect(input).not.toContain('-error')
    const select = render(
      createElement(
        Select,
        {
          label: 'Mode',
          defaultValue: 'brief'
        },
        createElement('option', { value: 'brief' }, 'Brief')
      )
    )
    expect(select).toContain('<select')
    expect(select).toContain('<option value="brief" selected="">Brief</option>')
  })

  it('keeps checkbox semantics and form values native', () => {
    const markup = render(
      createElement(Checkbox, {
        label: 'Complete',
        name: 'complete',
        value: 'yes',
        defaultChecked: true
      })
    )
    expect(markup).toContain('type="checkbox"')
    expect(markup).toContain('checked=""')
    expect(markup).toContain('name="complete"')
    expect(markup).toContain('value="yes"')
    expect(markup).toContain('Complete')
  })

  it('exposes a named radiogroup with one enabled tab stop', () => {
    const markup = render(
      createElement(SegmentedControl, {
        label: 'Layout',
        value: 'board',
        onChange: () => {},
        options: [
          { value: 'list', label: 'List' },
          { value: 'board', label: 'Board' },
          { value: 'other', label: 'Other', disabled: true }
        ]
      })
    )
    expect(markup).toContain('role="radiogroup"')
    expect(markup).toContain('aria-label="Layout"')
    expect(markup.match(/role="radio"/g)).toHaveLength(3)
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1)
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1)
  })

  it('keeps only the first enabled radio tabbable when the selected option is disabled', () => {
    const markup = render(
      createElement(SegmentedControl, {
        label: 'Mode',
        value: 'disabled',
        onChange: () => {},
        options: [
          { value: 'disabled', label: 'Unavailable', disabled: true },
          { value: 'brief', label: 'Brief' },
          { value: 'deep', label: 'Deep' }
        ]
      })
    )
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1)
    expect(markup).toMatch(/tabindex="0"[^>]*>Brief<\/button>/)
  })

  it('has no tabbable radios when all options are disabled', () => {
    const markup = render(
      createElement(SegmentedControl, {
        label: 'Mode',
        value: 'brief',
        disabled: true,
        onChange: () => {},
        options: [{ value: 'brief', label: 'Brief' }]
      })
    )
    expect(markup).toContain('aria-disabled="true"')
    expect(markup).not.toContain('tabindex="0"')
  })

  it('exposes action menu semantics, disabled entries and trigger state', () => {
    const markup = render(
      createElement(Menu, {
        defaultOpen: true,
        label: 'Project actions',
        items: [
          { id: 'edit', label: 'Edit', onSelect: () => {} },
          { id: 'delete', label: 'Delete', onSelect: () => {}, danger: true, disabled: true }
        ]
      })
    )
    expect(markup).toContain('aria-haspopup="menu"')
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('role="menu"')
    expect(markup.match(/role="menuitem"/g)).toHaveLength(2)
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('text-hard')
  })

  it.each([24, 32, 40, 48])('renders small %ipx covers as a hue band only', (size) => {
    const projectId = 'project-42'
    const art = coverFor(projectId, 'COMP6991')
    const markup = render(createElement(Cover, { projectId, name: 'COMP6991', size }))
    expect(markup).toContain(`width:${size}px;height:${size}px`)
    expect(markup).toContain(`var(--color-${art.hue})`)
    expect(markup).toContain(`top:${art.band * 26}%`)
    expect(markup).not.toContain('6991</span>')
    expect(markup).toContain('aria-label="COMP6991"')
  })

  it.each([56, 73, 96, 160, 220])(
    'renders %ipx covers with type above a lower-half band',
    (size) => {
      const projectId = 'project-42'
      const art = coverFor(projectId, 'comp6991')
      const markup = render(createElement(Cover, { projectId, name: 'comp6991', size }))
      expect(markup).toContain(`var(--color-${art.hue})`)
      expect(markup).toContain(`top:${52 + art.band * 8}%`)
      expect(markup).toContain('COMP</span>')
      expect(markup).toContain('6991</span>')
      expect(markup).toContain('aria-label="comp6991"')
    }
  )

  it('allows decorative covers and skeletons to stay out of the accessibility tree', () => {
    expect(
      render(createElement(Cover, { projectId: 'p', name: 'My project', decorative: true }))
    ).toContain('aria-hidden="true"')
    const skeleton = render(createElement(Skeleton, { width: 96, height: 24 }))
    expect(skeleton).toContain('aria-hidden="true"')
    expect(skeleton).toContain('width:96px;height:24px')
    expect(skeleton).not.toContain('animate-')
  })

  it('formats local dates and deadlines, rejecting invalid keys', () => {
    const today = new Date(2026, 6, 7, 23, 30)
    expect(render(createElement(DayLabel, { date: '2026-07-07', today }))).toContain('Today')
    expect(render(createElement(DayLabel, { date: '2026-07-08', today }))).toContain('Tomorrow')
    expect(render(createElement(DayLabel, { date: '2026-08-01', deadline: true }))).toContain(
      'Due Sat 1 Aug'
    )
    expect(render(createElement(DayLabel, { date: '2026-02-30' }))).toBe('')
  })

  it('renders text alongside difficulty colors, empty-state actions, and keyboard hints', () => {
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const markup = render(createElement(DifficultyTag, { difficulty }))
      expect(markup).toContain(`bg-${difficulty}`)
      expect(markup).toContain(difficulty[0].toUpperCase() + difficulty.slice(1))
    }
    const empty = render(
      createElement(EmptyState, {
        icon: FolderOpen,
        title: 'No projects yet',
        description: 'Create a project to get started.',
        action: createElement(Button, null, 'Create project')
      })
    )
    expect(empty).toContain('No projects yet')
    expect(empty).toContain('Create project')
    expect(render(createElement(Kbd, null, '⌘ K'))).toContain('⌘ K</kbd>')
    expect(render(createElement(Drawer, { open: false, title: 'Notes', onClose: () => {} }))).toBe(
      ''
    )
  })
})

describe('keyboard navigation and focus utilities', () => {
  it('wraps arrow navigation in both directions and skips disabled entries', () => {
    expect(nextEnabledIndex([false, true, false], 0, 1)).toBe(2)
    expect(nextEnabledIndex([false, true, false], 2, 1)).toBe(0)
    expect(nextEnabledIndex([false, true, false], 0, -1)).toBe(2)
    expect(nextEnabledIndex([false, true, false], 2, -1)).toBe(0)
    expect(nextEnabledIndex([true, true], 0, 1)).toBe(-1)
    expect(nextEnabledIndex([], -1, 1)).toBe(-1)
  })

  it('forwards React 19 object refs and callback cleanup', () => {
    const ref = createRef<HTMLElement>()
    const element = {} as HTMLElement
    setRef(ref, element)
    expect(ref.current).toBe(element)
    setRef(ref, null)
    expect(ref.current).toBeNull()
    const cleanup = vi.fn()
    const callback = vi.fn(() => cleanup)
    expect(setRef(callback, element)).toBe(cleanup)
    expect(callback).toHaveBeenCalledWith(element)
  })

  function fakeElement(overrides: Record<string, unknown> = {}): HTMLElement {
    return {
      tabIndex: 0,
      matches: () => false,
      closest: () => null,
      getClientRects: () => [{ width: 20, height: 20 }],
      ...overrides
    } as unknown as HTMLElement
  }

  function fakeContainer(elements: HTMLElement[]): HTMLElement {
    return { querySelectorAll: () => elements } as unknown as HTMLElement
  }

  it('excludes disabled, hidden, inert and non-tabbable elements from focus trapping', () => {
    vi.stubGlobal('getComputedStyle', (element: HTMLElement) => ({
      visibility: element.id === 'hidden' ? 'hidden' : 'visible'
    }))
    const visible = fakeElement()
    const container = fakeContainer([
      visible,
      fakeElement({ tabIndex: -1 }),
      fakeElement({ matches: () => true }),
      fakeElement({ closest: () => ({}) }),
      fakeElement({ getClientRects: () => [] }),
      fakeElement({ id: 'hidden' })
    ])
    expect(focusableElements(container)).toEqual([visible])
  })

  it('wraps Tab/Shift+Tab at boundaries, recovers escaped focus and handles empty panels', () => {
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }))
    const first = fakeElement()
    const middle = fakeElement()
    const last = fakeElement()
    const container = fakeContainer([first, middle, last])
    expect(tabFocusTarget(container, last, false)).toBe(first)
    expect(tabFocusTarget(container, first, true)).toBe(last)
    expect(tabFocusTarget(container, middle, false)).toBeNull()
    expect(tabFocusTarget(container, middle, true)).toBeNull()
    expect(tabFocusTarget(container, null, false)).toBe(first)
    expect(tabFocusTarget(container, null, true)).toBe(last)
    const empty = fakeContainer([])
    expect(tabFocusTarget(empty, null, false)).toBe(empty)
  })
})
