import { useId, type ComponentPropsWithRef, type JSX, type ReactNode } from 'react'
import { Field } from './Field'
import { cx, fieldClass } from './internal'

export interface InputProps extends ComponentPropsWithRef<'input'> {
  error?: string
  label?: ReactNode
}

export function Input({ error, label, id, className, ...props }: InputProps): JSX.Element {
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const errorId = `${fieldId}-error`
  return (
    <Field id={fieldId} errorId={errorId} error={error} label={label}>
      <input
        {...props}
        id={fieldId}
        aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={cx(props['aria-describedby'], error && errorId) || undefined}
        className={cx(
          fieldClass,
          error ? 'border-hard focus:border-hard' : 'border-line-strong focus:border-accent',
          className
        )}
      />
    </Field>
  )
}
