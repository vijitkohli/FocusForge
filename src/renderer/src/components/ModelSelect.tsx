import type { JSX } from 'react'
import { MODEL_GROUPS } from 'src/common/models'
import { Select, type SelectProps } from '../ui'

export interface ModelSelectProps extends Omit<SelectProps, 'value' | 'onChange' | 'children'> {
  value: string
  onChange: (value: string) => void
  emptyOption?: { value: string; label: string }
}

/** Retain saved/custom models even when they are no longer in the catalogue. */
export function ModelSelect({
  value,
  onChange,
  emptyOption,
  ...props
}: ModelSelectProps): JSX.Element {
  const known = MODEL_GROUPS.some((group) => group.options.some((option) => option.value === value))
  const isEmpty = emptyOption && value === emptyOption.value

  return (
    <Select {...props} value={value} onChange={(event) => onChange(event.target.value)}>
      {emptyOption && <option value={emptyOption.value}>{emptyOption.label}</option>}
      {!known && !isEmpty && <option value={value}>{value}</option>}
      {MODEL_GROUPS.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  )
}
