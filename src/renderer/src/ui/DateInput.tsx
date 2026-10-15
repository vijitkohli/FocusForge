import { CalendarDays } from 'lucide-react'
import { useRef, type FocusEvent, type JSX } from 'react'
import { IconButton } from './IconButton'
import { Input, type InputProps } from './Input'
import { cx, setRef } from './internal'

export interface DateInputProps extends Omit<InputProps, 'type'> {
  /** Fires only when focus leaves both the field and its calendar button. */
  onGroupBlur?: (event: FocusEvent<HTMLDivElement>) => void
  pickerLabel?: string
}

/**
 * Native date field with our own calendar button. Chromium's built-in picker
 * indicator is a focusable UA-shadow control whose blue focus ring can't be
 * themed, so it is hidden (`.date-input` in tailwind.css) and replaced with an
 * IconButton that opens the same native picker via `showPicker()`.
 */
export function DateInput({
  onGroupBlur,
  pickerLabel = 'Open calendar',
  className,
  ref,
  ...props
}: DateInputProps): JSX.Element {
  const input = useRef<HTMLInputElement | null>(null)
  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onGroupBlur?.(event)
      }}
    >
      <Input
        {...props}
        ref={(node) => {
          input.current = node
          return setRef(ref, node)
        }}
        type="date"
        className={cx('date-input pr-10', className)}
      />
      <IconButton
        label={pickerLabel}
        icon={CalendarDays}
        disabled={props.disabled}
        className="absolute bottom-0.5 right-0.5"
        onClick={() => {
          const node = input.current
          if (!node) return
          try {
            node.showPicker()
          } catch {
            node.focus()
          }
        }}
      />
    </div>
  )
}
