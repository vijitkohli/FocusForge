import type { JSX, ReactNode } from 'react'

interface FieldProps {
  id: string
  errorId: string
  error?: string
  label?: ReactNode
  children: ReactNode
}

export function Field({ id, errorId, error, label, children }: FieldProps): JSX.Element {
  return (
    <div className="min-w-0 space-y-1.5">
      {label != null && (
        <label htmlFor={id} className="block text-[12.5px] font-medium text-fg-2">
          {label}
        </label>
      )}
      {children}
      {error && (
        <p id={errorId} role="alert" className="text-[12.5px] text-hard">
          {error}
        </p>
      )}
    </div>
  )
}
