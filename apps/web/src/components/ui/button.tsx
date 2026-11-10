'use client';

/** Button primitives, one source of truth for every action in the app. */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-navy text-sheet border border-navy hover:bg-navy-hover active:translate-y-px',
  secondary:
    'bg-sheet text-ink border border-rule-strong hover:border-ink hover:bg-vellum',
  ghost:
    'bg-transparent text-ink-2 border border-transparent hover:text-ink hover:bg-vellum',
  danger:
    'bg-danger-tint text-danger border border-danger hover:bg-danger hover:text-sheet',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'min-h-11 px-3 text-xs gap-1.5 sm:min-h-9',
  md: 'min-h-11 px-4 text-sm gap-2',
  lg: 'min-h-12 px-5 text-base gap-2',
};

export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  extra = '',
): string {
  return [
    'inline-flex items-center justify-center rounded-control font-medium tracking-[0.01em]',
    'transition-colors duration-[var(--duration-ui)] ease-[var(--ease-instrument)]',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-inherit',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Label shown while loading; keeps the button width stable. */
  loadingLabel?: ReactNode;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    loadingLabel,
    icon,
    children,
    className = '',
    disabled,
    ...rest
  },
  ref,
) {
  const stable = loading && loadingLabel != null;
  return (
    <button
      ref={ref}
      type="button"
      className={buttonClasses(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {stable ? (
        <span className="inline-grid items-center">
          <span className="invisible col-start-1 row-start-1 inline-flex items-center gap-[inherit]">
            {icon}
            {children}
          </span>
          <span className="col-start-1 row-start-1 inline-flex items-center justify-center gap-[inherit]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} aria-hidden />
            {loadingLabel}
          </span>
        </span>
      ) : (
        <>
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} aria-hidden />
          ) : (
            icon
          )}
          {children}
        </>
      )}
    </button>
  );
});
