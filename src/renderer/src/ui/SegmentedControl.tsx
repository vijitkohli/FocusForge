import type { LucideIcon } from 'lucide-react'
import { useRef, type ComponentPropsWithRef, type JSX, type ReactNode } from 'react'
import { cx, disabledControl, focusRing, nextEnabledIndex } from './internal'

export interface SegmentedOption<Value extends string = string> {
  value: Value
  label: ReactNode
  icon?: LucideIcon
  disabled?: boolean
}

export interface SegmentedControlProps<Value extends string = string> extends Omit<
  ComponentPropsWithRef<'div'>,
  'onChange'
> {
  label: string
  options: readonly SegmentedOption<Value>[]
  value: Value
  onChange: (value: Value) => void
  disabled?: boolean
  orientation?: 'horizontal' | 'vertical'
}

export function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  orientation = 'horizontal',
  className,
  onKeyDown,
  ...props
}: SegmentedControlProps<Value>): JSX.Element {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const unavailable = options.map((option) => disabled || !!option.disabled)
  const selected = options.findIndex(
    (option, index) => option.value === value && !unavailable[index]
  )
  const tabStop = selected >= 0 ? selected : unavailable.findIndex((item) => !item)

  return (
    <div
      {...props}
      role="radiogroup"
      aria-label={label}
      aria-orientation={orientation}
      aria-disabled={disabled || undefined}
      className={cx(
        'inline-flex gap-1 rounded-full border border-line bg-bg-0 p-1',
        orientation === 'vertical' && 'flex-col rounded-md',
        className
      )}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented || disabled) return
        const current = buttons.current.findIndex((button) => button === event.target)
        if (current < 0) return
        let next: number
        switch (event.key) {
          case 'ArrowRight':
          case 'ArrowDown':
            next = nextEnabledIndex(unavailable, current, 1)
            break
          case 'ArrowLeft':
          case 'ArrowUp':
            next = nextEnabledIndex(unavailable, current, -1)
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
        if (next >= 0) {
          buttons.current[next]?.focus()
          onChange(options[next].value)
        }
      }}
    >
      {options.map(({ value: optionValue, label: optionLabel, icon: Icon }, index) => (
        <button
          key={optionValue}
          ref={(element) => {
            buttons.current[index] = element
          }}
          type="button"
          role="radio"
          aria-checked={value === optionValue}
          disabled={unavailable[index]}
          tabIndex={index === tabStop ? 0 : -1}
          onClick={() => onChange(optionValue)}
          className={cx(
            'inline-flex min-h-7 items-center justify-center gap-2 rounded-full px-3 text-[12.5px] font-medium',
            value === optionValue ? 'bg-bg-3 text-fg-1' : 'text-fg-2 hover:bg-bg-2 hover:text-fg-1',
            focusRing,
            disabledControl
          )}
        >
          {Icon && <Icon size={18} strokeWidth={1.75} aria-hidden="true" />}
          {optionLabel}
        </button>
      ))}
    </div>
  )
}
