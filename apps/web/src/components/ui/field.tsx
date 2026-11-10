'use client';

/** Form controls with labels, hints, and specific inline errors. */
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

const CONTROL =
  'block w-full min-h-11 rounded-control border border-rule-strong bg-sheet px-3 py-2 text-sm text-ink ' +
  'placeholder:text-ink-3 transition-colors duration-[var(--duration-ui)] ' +
  'hover:border-ink-3 focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/30 ' +
  'disabled:cursor-not-allowed disabled:bg-vellum disabled:text-ink-2';

function fieldId(id: string | undefined, generated: string): string {
  return id ?? generated;
}

function ErrorIcon() {
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8v4M8 11.2v.2" />
    </svg>
  );
}

export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="flex items-baseline gap-2 text-sm font-medium text-ink">
        <span>{label}</span>
        {required ? <span className="text-caps text-ink-3">Required</span> : null}
      </label>
      {children}
      {error ? (
        <p className="flex items-start gap-1.5 text-sm text-danger" role="alert">
          <ErrorIcon />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <div className="text-xs text-ink-2">{hint}</div>
      ) : null}
    </div>
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, id, required, className = '', ...rest },
  ref,
) {
  const auto = useId();
  const inputId = fieldId(id, auto);
  const control = (
    <input
      ref={ref}
      id={inputId}
      required={required}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${inputId}-error` : undefined}
      className={`${CONTROL} ${error ? 'border-danger' : ''} ${className}`}
      {...rest}
    />
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={inputId}>
      {control}
    </Field>
  );
});

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, id, required, className = '', rows = 4, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = fieldId(id, auto);
  const control = (
    <textarea
      ref={ref}
      id={inputId}
      rows={rows}
      required={required}
      aria-invalid={error ? true : undefined}
      className={`${CONTROL} ${error ? 'border-danger' : ''} ${className}`}
      {...rest}
    />
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={inputId}>
      {control}
    </Field>
  );
});

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, id, required, className = '', children, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = fieldId(id, auto);
  const control = (
    <select
      ref={ref}
      id={inputId}
      required={required}
      aria-invalid={error ? true : undefined}
      className={`${CONTROL} ${error ? 'border-danger' : ''} ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={inputId}>
      {control}
    </Field>
  );
});
