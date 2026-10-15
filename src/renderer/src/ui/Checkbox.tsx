import { Check } from 'lucide-react'
import type { ComponentPropsWithRef, JSX, ReactNode } from 'react'
import { cx } from './internal'

export interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'size'> {
  label?: ReactNode
}

export function Checkbox({ label, className, disabled, ...props }: CheckboxProps): JSX.Element {
  return (
    <label
      className={cx(
        'inline-flex items-center gap-2 text-sm text-fg-1',
        disabled ? 'cursor-default opacity-45' : 'cursor-pointer'
      )}
    >
      <span className="relative inline-flex size-[18px] shrink-0">
        <input
          {...props}
          type="checkbox"
          disabled={disabled}
          className={cx('peer sr-only', className)}
        />
        <span
          className="flex size-[18px] items-center justify-center rounded-xs border border-line-strong bg-bg-2 peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-checked:[&>svg]:visible"
          aria-hidden="true"
        >
          <Check size={14} strokeWidth={1.75} className="invisible text-on-accent" />
        </span>
      </span>
      {label}
    </label>
  )
}
