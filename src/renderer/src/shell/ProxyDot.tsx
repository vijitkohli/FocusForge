import type { JSX } from 'react'
import { useWhatNext } from '../lib/whatNextStore'

/** 8px sidebar dot. Amber when the proxy is down, never red, and no toasts. */
export function ProxyDot({ collapsed }: { collapsed: boolean }): JSX.Element | null {
  const { proxy } = useWhatNext()
  if (proxy.status === 'unknown' || proxy.status === 'not-used') return null
  const up = proxy.status === 'up'
  const label = up
    ? 'AI connected'
    : 'AI offline. Background prep is paused; everything else works.'
  return (
    <div
      role="status"
      aria-label={label}
      title={label}
      className={`flex h-11 items-center text-sm text-fg-2 ${collapsed ? 'justify-center' : 'gap-3 px-3'}`}
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${up ? 'bg-easy' : 'bg-medium'}`}
      />
      <span className={collapsed ? 'sr-only' : undefined}>AI</span>
    </div>
  )
}
