/** Loading / empty / error states, typographic, ruled, never illustrated. */
import type { CSSProperties, ReactNode } from 'react';
import { Button } from './button';

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton-rule ${className}`} aria-hidden />;
}

export function LoadingStatus({ text = 'Loading' }: { text?: string }) {
  return (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </p>
  );
}

export function CardSkeleton({
  rows = 3,
  className = '',
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div
      className={`border border-rule bg-sheet p-5 ${className}`.trim()}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading"
    >
      <Skeleton className="h-3 w-32" />
      <div className="mt-5 space-y-4">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-px w-full" />
            <Skeleton className="h-px w-4/5" />
          </div>
        ))}
      </div>
      <LoadingStatus />
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      className="border-y border-rule bg-sheet"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-rule px-4 py-4 last:border-b-0">
          <Skeleton className="h-2.5 w-2.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2.5">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-px w-1/3" />
          </div>
          <Skeleton className="h-3 w-20 shrink-0" />
        </div>
      ))}
      <LoadingStatus />
    </div>
  );
}

export function staggerStyle(index: number): CSSProperties {
  return { '--stagger-index': Math.min(index, 7) } as CSSProperties;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="border-y border-rule bg-sheet px-6 py-12">
      <p className="text-caps text-ink-3">Nothing here yet</p>
      <h3 className="mt-2 max-w-prose text-lg text-ink">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-prose text-sm text-ink-2">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
}: {
  title?: string;
  description?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="border-l-2 border-danger bg-danger-tint px-5 py-5" role="alert">
      <p className="text-caps text-danger">That did not work</p>
      <h3 className="mt-1 text-lg text-ink">{title}</h3>
      {description ? <p className="mt-1 max-w-prose text-sm text-ink-2">{description}</p> : null}
      <p className="mt-2 text-xs text-ink-2">
        Your data is unchanged. You can try again safely.
      </p>
      {onRetry ? (
        <div className="mt-4">
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
