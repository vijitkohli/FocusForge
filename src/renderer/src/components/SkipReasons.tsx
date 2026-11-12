import type { JSX } from 'react'
import { Button } from '../ui'
import type { SkipPrompt } from '../lib/whatNextStore'

export function SkipReasons({
  prompt,
  onReason,
  onTooBig,
  onBringBack
}: {
  prompt: SkipPrompt
  onReason: (reason: 'not-now' | 'tired') => void
  onTooBig: () => void
  onBringBack: () => void
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Why not that one?"
      className="motion-menu mt-3 flex flex-wrap items-center justify-center gap-2"
    >
      <p className="text-sm text-fg-2">Skipped. Want to say why?</p>
      <Button size="sm" variant="ghost" onClick={() => onReason('not-now')}>
        Not now
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onReason('tired')}>
        Tired of this
      </Button>
      <Button size="sm" variant="ghost" onClick={onTooBig}>
        Too big
      </Button>
      <Button size="sm" variant="ghost" onClick={onBringBack}>
        Bring it back
      </Button>
      <span className="sr-only">{prompt.title}</span>
    </div>
  )
}
