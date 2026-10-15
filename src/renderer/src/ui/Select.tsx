import { useId, type ComponentPropsWithRef, type JSX, type ReactNode } from 'react'
import { Field } from './Field'
import { cx, fieldClass } from './internal'

export interface SelectProps extends ComponentPropsWithRef<'select'> {
  error?: string
  label?: ReactNode
}

export function Select({
  error,
  label,
  id,
  className,
  children,
  ...props
}: SelectProps): JSX.Element {
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const errorId = `${fieldId}-error`
  return (
    <Field id={fieldId} errorId={errorId} error={error} label={label}>
      <select
        {...props}
        id={fieldId}
        aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={cx(props['aria-describedby'], error && errorId) || undefined}
        className={cx(
          fieldClass,
          error ? 'border-hard focus:border-hard' : 'border-line-strong focus:border-accent',
          className
        )}
      >
        {children}
      </select>
    </Field>
  )
}
