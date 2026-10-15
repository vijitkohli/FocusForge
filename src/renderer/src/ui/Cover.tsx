import type { ComponentPropsWithRef, JSX } from 'react'
import { coverFor } from '../lib/cover'
import { cx } from './internal'

export interface CoverProps extends Omit<ComponentPropsWithRef<'div'>, 'children'> {
  projectId: string
  name: string
  size?: number
  decorative?: boolean
}

export function Cover({
  projectId,
  name,
  size = 48,
  decorative = false,
  className,
  style,
  ...props
}: CoverProps): JSX.Element {
  const { hue, band, lines } = coverFor(projectId, name)
  // Below ~56px the type is unreadable, and the name always sits beside the
  // cover there, so small covers carry identity through the hue band alone.
  const showText = size >= 56
  const longest = Math.max(1, ...lines.map((line) => line.length))
  // Scale long single words ("leetcode") to fit the inner width rather than truncate.
  const fontSize = Math.min(size * 0.18, (size * 0.8) / (longest * 0.62))
  return (
    <div
      {...props}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : (props['aria-label'] ?? name)}
      aria-hidden={decorative || props['aria-hidden']}
      className={cx('relative shrink-0 overflow-hidden rounded-sm bg-bg-3 text-fg-1', className)}
      style={{ width: size, height: size, ...style }}
    >
      {/* Band sits in the lower half (52–76% from the top) so it never runs under the type. */}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 h-[22%]"
        style={{
          top: showText ? `${52 + band * 8}%` : `${band * 26}%`,
          backgroundColor: `var(--color-${hue})`
        }}
      />
      {showText && (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 flex flex-col leading-[1.05] font-extrabold tracking-[-0.03em]"
          style={{ padding: size * 0.1, fontSize }}
        >
          {lines.map((line, index) => (
            <span key={index} className="truncate">
              {line}
            </span>
          ))}
        </span>
      )}
    </div>
  )
}
