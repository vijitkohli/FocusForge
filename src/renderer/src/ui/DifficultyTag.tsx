import type { ComponentPropsWithRef, JSX } from 'react'
import { cx } from './internal'

export interface DifficultyTagProps extends ComponentPropsWithRef<'span'> {
  difficulty: 'easy' | 'medium' | 'hard'
}

const colors = { easy: 'bg-easy', medium: 'bg-medium', hard: 'bg-hard' }
const labels = { easy: 'Easy', medium: 'Medium', hard: 'Hard' }

export function DifficultyTag({
  difficulty,
  className,
  ...props
}: DifficultyTagProps): JSX.Element {
  return (
    <span
      {...props}
      className={cx(
        'inline-flex items-center gap-1.5 text-[12.5px] font-medium text-fg-2',
        className
      )}
    >
      <span aria-hidden="true" className={cx('size-2 shrink-0 rounded-full', colors[difficulty])} />
      {labels[difficulty]}
    </span>
  )
}
