import { Pause, Play } from 'lucide-react'
import type { ComponentPropsWithRef, JSX } from 'react'
import { cx, disabledControl, focusRing } from './internal'

export interface PlayButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  playing?: boolean
  size?: 36 | 64 | 80
  label?: string
}

const sizes = { 36: 'size-9', 64: 'size-16', 80: 'size-20' }

export function PlayButton({
  playing = false,
  size = 64,
  label = playing ? 'Pause' : 'Play',
  className,
  type = 'button',
  ...props
}: PlayButtonProps): JSX.Element {
  const Icon = playing ? Pause : Play
  return (
    <button
      {...props}
      type={type}
      aria-label={label}
      title={props.title ?? label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-accent text-on-accent hover:bg-accent-hover active:scale-[0.96] active:bg-accent-press motion-safe:transition-[background-color,transform]',
        sizes[size],
        focusRing,
        disabledControl,
        className
      )}
    >
      <Icon
        size={size === 36 ? 18 : size === 64 ? 28 : 36}
        strokeWidth={1.75}
        fill="currentColor"
        aria-hidden="true"
        className={!playing ? 'translate-x-px' : undefined}
      />
    </button>
  )
}
