import type { LucideIcon } from 'lucide-react'
import type { ComponentPropsWithRef, JSX } from 'react'
import { cx, disabledControl, focusRing } from './internal'

export interface IconButtonProps extends ComponentPropsWithRef<'button'> {
  label: string
  icon?: LucideIcon
  size?: 32 | 36
  variant?: 'ghost' | 'secondary' | 'danger'
}

const variants = {
  ghost: 'bg-transparent text-fg-2 hover:bg-bg-2 hover:text-fg-1 active:bg-bg-3',
  secondary: 'bg-bg-3 text-fg-1 hover:bg-bg-4 active:bg-bg-2',
  danger: 'bg-transparent text-hard hover:bg-hard/10 active:bg-hard/20'
}

export function IconButton({
  label,
  icon: Icon,
  size = 32,
  variant = 'ghost',
  children,
  className,
  type = 'button',
  ...props
}: IconButtonProps): JSX.Element {
  return (
    <button
      {...props}
      type={type}
      aria-label={label}
      title={props.title ?? label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full transition-colors motion-reduce:transition-none',
        size === 32 ? 'size-8' : 'size-9',
        variants[variant],
        focusRing,
        disabledControl,
        className
      )}
    >
      {Icon ? <Icon size={18} strokeWidth={1.75} aria-hidden="true" /> : children}
    </button>
  )
}
