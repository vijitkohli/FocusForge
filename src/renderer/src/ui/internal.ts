import type { Ref } from 'react'

export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

export const disabledControl = 'disabled:pointer-events-none disabled:opacity-45'

export const fieldClass = cx(
  'w-full rounded-md border bg-bg-2 px-3 py-2 text-sm leading-[1.55] text-fg-1 placeholder:text-fg-2 focus:outline-2 focus:outline-offset-2 focus:outline-accent',
  disabledControl
)

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function setRef<T>(ref: Ref<T> | undefined, value: T | null): void | (() => void) {
  if (typeof ref === 'function') return ref(value)
  if (ref) ref.current = value
}

export function nextEnabledIndex(
  disabled: readonly boolean[],
  current: number,
  direction: 1 | -1
): number {
  for (let step = 1; step <= disabled.length; step++) {
    const index = (current + direction * step + disabled.length) % disabled.length
    if (!disabled[index]) return index
  }
  return -1
}

export function tabFocusTarget(
  container: HTMLElement,
  activeElement: Element | null,
  backwards: boolean
): HTMLElement | null {
  const targets = focusableElements(container)
  const first = targets[0]
  const last = targets[targets.length - 1]
  if (!first) return container
  if (!targets.includes(activeElement as HTMLElement)) return backwards ? last : first
  if (backwards && activeElement === first) return last
  if (!backwards && activeElement === last) return first
  return null
}

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button, input, textarea, select, [tabindex], [contenteditable="true"]'
    )
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden'
  )
}
