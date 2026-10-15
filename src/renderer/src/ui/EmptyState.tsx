import type { LucideIcon } from 'lucide-react'
import type { ComponentPropsWithRef, JSX, ReactNode } from 'react'
import { cx } from './internal'

export interface EmptyStateProps extends Omit<ComponentPropsWithRef<'div'>, 'title' | 'children'> {
  icon: LucideIcon
  title: string
  description: string
  action?: ReactNode
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps): JSX.Element {
  return (
    <div
      {...props}
      className={cx('flex flex-col items-center gap-3 px-6 py-12 text-center', className)}
    >
      <Icon size={32} strokeWidth={1.75} aria-hidden="true" className="mb-1 text-fg-2" />
      <h3 className="text-lg leading-[1.3] font-bold tracking-[-0.01em] text-fg-1">{title}</h3>
      <p className="max-w-[72ch] text-sm leading-[1.55] text-fg-2">{description}</p>
      {action != null && <div className="mt-2">{action}</div>}
    </div>
  )
}
