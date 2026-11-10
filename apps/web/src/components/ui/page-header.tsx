/** Page title block. */
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-rule pb-5">
      <div className="min-w-0">
        {breadcrumb ? <div className="mb-2 text-xs text-ink-3">{breadcrumb}</div> : null}
        <h1 className="text-2xl text-ink">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-prose text-sm text-ink-2">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
