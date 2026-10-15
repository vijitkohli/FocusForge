import type { JSX } from 'react'
import type { burndownData } from './burndownData'

export function Burndown({
  data
}: {
  data: NonNullable<ReturnType<typeof burndownData>>
}): JSX.Element {
  return (
    <svg
      width="240"
      height="48"
      viewBox="0 0 240 48"
      className="max-w-full shrink-0"
      role="img"
      aria-label={`Steps remaining: ${data.status}. Dashed line is ideal progress; solid line is actual progress.`}
    >
      <line
        x1="0"
        y1="2"
        x2="240"
        y2="46"
        stroke="currentColor"
        className="text-fg-3"
        strokeWidth="1"
        strokeDasharray="4 4"
      />
      <polyline
        points={data.points}
        fill="none"
        stroke="currentColor"
        className="text-accent"
        strokeWidth="1.5"
      />
    </svg>
  )
}
