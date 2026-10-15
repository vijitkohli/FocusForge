import type { ComponentPropsWithRef, CSSProperties, JSX } from 'react'
import { cx } from './internal'

export interface SkeletonProps extends Omit<ComponentPropsWithRef<'div'>, 'children'> {
  width?: CSSProperties['width']
  height?: CSSProperties['height']
  circle?: boolean
}

export function Skeleton({
  width,
  height,
  circle = false,
  className,
  style,
  ...props
}: SkeletonProps): JSX.Element {
  return (
    <div
      {...props}
      aria-hidden="true"
      className={cx('h-4 bg-bg-3', circle ? 'rounded-full' : 'rounded-sm', className)}
      style={{ width, height, ...style }}
    />
  )
}
