import { useId, type ComponentPropsWithRef, type JSX, type ReactNode } from 'react'
import { Field } from './Field'
import { cx, fieldClass } from './internal'

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  error?: string
  label?: ReactNode
}

export function Textarea({
  error,
  label,
  id,
  className,
  rows = 4,
  ...props
}: TextareaProps): JSX.Element {
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const errorId = `${fieldId}-error`
  return (
    <Field id={fieldId} errorId={errorId} error={error} label={label}>
      <textarea
        {...props}
        id={fieldId}
        rows={rows}
        aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={cx(props['aria-describedby'], error && errorId) || undefined}
        className={cx(
          fieldClass,
          'min-h-24 resize-y',
          error ? 'border-hard focus:border-hard' : 'border-line-strong focus:border-accent',
          className
        )}
      />
    </Field>
  )
}
