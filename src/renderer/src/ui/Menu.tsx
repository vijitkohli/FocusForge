import { Ellipsis, type LucideIcon } from 'lucide-react'
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type JSX,
  type ReactNode
} from 'react'
import { IconButton } from './IconButton'
import { cx, focusRing, nextEnabledIndex } from './internal'

export interface MenuItem {
  id: string
  label: ReactNode
  onSelect: () => void
  icon?: LucideIcon
  disabled?: boolean
  danger?: boolean
}

export interface MenuProps extends ComponentPropsWithRef<'div'> {
  items: readonly MenuItem[]
  label?: string
  icon?: LucideIcon
  align?: 'start' | 'end'
  disabled?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export function Menu({
  items,
  label = 'More options',
  icon = Ellipsis,
  align = 'end',
  disabled = false,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
  ...props
}: MenuProps): JSX.Element {
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const open = controlledOpen ?? localOpen
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const initialPosition = useRef<'first' | 'last'>('first')
  const id = useId()

  function changeOpen(next: boolean): void {
    if (controlledOpen === undefined) setLocalOpen(next)
    onOpenChange?.(next)
    if (!next) trigger.current?.focus()
  }

  const closeFromOutside = useEffectEvent(() => changeOpen(false))

  useEffect(() => {
    if (!open) return
    const menuElement = list.current
    const triggerElement = trigger.current
    const available = itemRefs.current.filter((item) => item && !item.disabled)
    const target =
      initialPosition.current === 'last' ? available[available.length - 1] : available[0]
    ;(target ?? list.current)?.focus()

    function onOutsideClick(event: MouseEvent): void {
      if (!(event.target instanceof Node)) return
      if (menuElement?.contains(event.target) || triggerElement?.contains(event.target)) return
      closeFromOutside()
    }
    function onEscape(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      closeFromOutside()
    }
    // Click follows pointer focus, so closing can reliably return focus to the trigger.
    document.addEventListener('click', onOutsideClick, true)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('click', onOutsideClick, true)
      document.removeEventListener('keydown', onEscape)
      if (
        triggerElement?.isConnected &&
        (menuElement?.contains(document.activeElement) || document.activeElement === document.body)
      ) {
        triggerElement.focus()
      }
    }
  }, [open])

  return (
    <div {...props} className={cx('relative inline-flex', className)}>
      <IconButton
        ref={trigger}
        label={label}
        icon={icon}
        disabled={disabled}
        id={`${id}-trigger`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          initialPosition.current = 'first'
          changeOpen(!open)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            initialPosition.current = event.key === 'ArrowUp' ? 'last' : 'first'
            changeOpen(true)
            if (open) {
              const available = itemRefs.current.filter((item) => item && !item.disabled)
              const target =
                event.key === 'ArrowUp' ? available[available.length - 1] : available[0]
              ;(target ?? list.current)?.focus()
            }
          }
        }}
      />
      {open && (
        <ul
          ref={list}
          id={id}
          role="menu"
          aria-labelledby={`${id}-trigger`}
          tabIndex={-1}
          className={cx(
            'motion-menu absolute top-full z-50 mt-1 min-w-44 rounded-md border border-line-strong bg-bg-2 p-1 text-sm text-fg-1 shadow-lg',
            align === 'end' ? 'right-0' : 'left-0',
            focusRing
          )}
          onKeyDown={(event) => {
            if (event.defaultPrevented) return
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              changeOpen(false)
              return
            }
            if (event.key === 'Tab') {
              changeOpen(false)
              return
            }
            const current = itemRefs.current.findIndex((item) => item === event.target)
            const unavailable = items.map((item) => !!item.disabled)
            let next: number
            switch (event.key) {
              case 'ArrowDown':
                next = nextEnabledIndex(unavailable, current, 1)
                break
              case 'ArrowUp':
                next = nextEnabledIndex(unavailable, current < 0 ? 0 : current, -1)
                break
              case 'Home':
                next = unavailable.findIndex((item) => !item)
                break
              case 'End':
                next = unavailable.findLastIndex((item) => !item)
                break
              default:
                return
            }
            event.preventDefault()
            if (next >= 0) itemRefs.current[next]?.focus()
          }}
        >
          {items.map(
            (
              {
                id: itemId,
                label: itemLabel,
                icon: Icon,
                onSelect,
                disabled: itemDisabled,
                danger
              },
              index
            ) => (
              <li key={itemId} role="none">
                <button
                  ref={(element) => {
                    itemRefs.current[index] = element
                  }}
                  type="button"
                  role="menuitem"
                  disabled={itemDisabled}
                  tabIndex={-1}
                  className={cx(
                    'flex min-h-9 w-full items-center gap-2 rounded-sm px-3 py-2 text-left disabled:opacity-45',
                    danger ? 'text-hard hover:bg-hard/10' : 'text-fg-1 hover:bg-bg-3',
                    focusRing
                  )}
                  onClick={() => {
                    changeOpen(false)
                    onSelect()
                  }}
                >
                  {Icon && <Icon size={18} strokeWidth={1.75} aria-hidden="true" />}
                  {itemLabel}
                </button>
              </li>
            )
          )}
        </ul>
      )}
    </div>
  )
}
