import type { ComponentPropsWithRef, JSX } from 'react'
import { cx } from './internal'

export interface KbdProps extends ComponentPropsWithRef<'kbd'> {}

export function Kbd({ className, children, ...props }: KbdProps): JSX.Element {
  return (
    <kbd
      {...props}
      className={cx(
        'inline-flex min-w-5 items-center justify-center rounded-xs border border-line-strong bg-bg-2 px-1.5 py-0.5 font-sans text-[12.5px] leading-none font-medium text-fg-2',
        className
      )}
    >
      {children}
    </kbd>
  )
}
