import { X } from 'lucide-react'
import { createPortal } from 'react-dom'
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  type ComponentPropsWithRef,
  type JSX,
  type ReactNode,
  type RefObject
} from 'react'
import { IconButton } from './IconButton'
import { cx, focusableElements, setRef, tabFocusTarget } from './internal'

export interface DrawerProps extends Omit<ComponentPropsWithRef<'section'>, 'title'> {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  initialFocusRef?: RefObject<HTMLElement | null>
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  initialFocusRef,
  children,
  className,
  ref,
  ...props
}: DrawerProps): JSX.Element | null {
  const panel = useRef<HTMLElement>(null)
  const id = useId()
  const requestClose = useEffectEvent(onClose)
  const focusInitially = useEffectEvent(() => {
    const element = panel.current
    if (!element) return
    const requested = initialFocusRef?.current
    const target =
      requested && element.contains(requested) ? requested : focusableElements(element)[0]
    ;(target ?? element).focus()
  })

  useEffect(() => {
    if (!open) return
    const element = panel.current
    if (!element) return
    const previousFocus = document.activeElement
    const background = Array.from(document.body.children)
      .filter(
        (sibling): sibling is HTMLElement =>
          sibling instanceof HTMLElement && sibling !== element.parentElement
      )
      .map((sibling) => ({ element: sibling, inert: sibling.inert }))
    const previousOverflow = document.body.style.overflow
    for (const sibling of background) sibling.element.inert = true
    document.body.style.overflow = 'hidden'
    focusInitially()

    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        requestClose()
      } else if (event.key === 'Tab') {
        const target = tabFocusTarget(element!, document.activeElement, event.shiftKey)
        if (target) {
          event.preventDefault()
          target.focus()
        }
      }
    }
    function onFocusIn(event: FocusEvent): void {
      if (event.target instanceof Node && !element?.contains(event.target)) focusInitially()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
      for (const sibling of background) sibling.element.inert = sibling.inert
      document.body.style.overflow = previousOverflow
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [open])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="motion-scrim fixed inset-0 z-50 flex justify-end bg-black/40"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        {...props}
        ref={(element) => {
          panel.current = element
          const cleanup = setRef(ref, element)
          return () => {
            panel.current = null
            if (cleanup) cleanup()
            else setRef(ref, null)
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props['aria-labelledby'] ?? `${id}-title`}
        aria-describedby={
          cx(props['aria-describedby'], description != null && `${id}-description`) || undefined
        }
        tabIndex={-1}
        className={cx(
          'motion-drawer flex h-full w-[480px] max-w-full flex-col rounded-l-md border-l border-line-strong bg-bg-1 text-fg-1 shadow-xl focus-visible:outline-2 focus-visible:outline-accent',
          className
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line p-6">
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="text-lg leading-[1.3] font-bold tracking-[-0.01em]">
              {title}
            </h2>
            {description != null && (
              <p id={`${id}-description`} className="mt-2 max-w-[72ch] text-sm text-fg-2">
                {description}
              </p>
            )}
          </div>
          <IconButton label="Close drawer" icon={X} onClick={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">{children}</div>
      </section>
    </div>,
    document.body
  )
}
