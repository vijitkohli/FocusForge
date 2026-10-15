import { LoaderCircle, type LucideIcon } from 'lucide-react'
import type { ComponentPropsWithRef, JSX } from 'react'
import { cx, disabledControl, focusRing } from './internal'

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  leadingIcon?: LucideIcon
  loading?: boolean
  loadingLabel?: string
}

const variants = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-press',
  secondary: 'bg-bg-3 text-fg-1 hover:bg-bg-4 active:bg-bg-2',
  ghost: 'bg-transparent text-fg-2 hover:bg-bg-2 hover:text-fg-1 active:bg-bg-3',
  danger: 'bg-transparent text-hard hover:bg-hard/10 active:bg-hard/20'
}
const sizes = { sm: 'h-7 px-3 text-[12.5px]', md: 'h-9 px-4 text-sm', lg: 'h-11 px-5 text-sm' }

export function Button({
  variant = 'secondary',
  size = 'md',
  leadingIcon: Icon,
  loading = false,
  loadingLabel = 'Loading',
  disabled,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps): JSX.Element {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || props['aria-busy']}
      className={cx(
        'relative inline-flex shrink-0 items-center justify-center rounded-full font-medium transition-colors motion-reduce:transition-none',
        variants[variant],
        sizes[size],
        focusRing,
        disabledControl,
        className
      )}
    >
      <span className={cx('inline-flex items-center justify-center gap-2', loading && 'opacity-0')}>
        {Icon && <Icon size={18} strokeWidth={1.75} aria-hidden="true" />}
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <LoaderCircle
            size={18}
            strokeWidth={1.75}
            className="animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="sr-only" role="status">
            {loadingLabel}
          </span>
        </span>
      )}
    </button>
  )
}
