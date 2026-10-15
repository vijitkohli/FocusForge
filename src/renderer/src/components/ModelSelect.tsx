import React from 'react'
import { MODEL_GROUPS } from 'src/common/models'

interface ModelSelectProps {
  value: string
  onChange: (value: string) => void
  // Optional leading option, e.g. { value: '', label: 'Same as chat model' }
  emptyOption?: { value: string; label: string }
  className?: string
}

const SELECT_CLASS =
  'rounded-md border border-border bg-bg-3 px-3 py-2 text-sm text-fg-1 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40'

/**
 * Model dropdown shared by the workspace and the settings card. A value that
 * isn't in MODEL_GROUPS (e.g. saved by an older build) is still shown, so the
 * select never silently displays the wrong model.
 */
export function ModelSelect({ value, onChange, emptyOption, className }: ModelSelectProps): React.JSX.Element {
  const known = MODEL_GROUPS.some((g) => g.options.some((o) => o.value === value))
  const isEmpty = emptyOption && value === emptyOption.value

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={className ?? SELECT_CLASS}>
      {emptyOption && <option value={emptyOption.value}>{emptyOption.label}</option>}
      {!known && !isEmpty && <option value={value}>{value}</option>}
      {MODEL_GROUPS.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
