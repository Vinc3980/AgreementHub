'use client';

/** Ruled text tabs, never pills. Counts read as ledger figures. */
import type { ReactNode } from 'react';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  /** Optional count (e.g. pending items). */
  count?: number;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: Array<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex gap-5 overflow-x-auto border-b border-rule"
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={[
              'inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap border-b-2 px-0.5 pb-2 text-sm font-medium transition-colors',
              active
                ? 'border-navy text-ink'
                : 'border-transparent text-ink-2 hover:border-rule-strong hover:text-ink',
            ].join(' ')}
          >
            {item.label}
            {typeof item.count === 'number' ? (
              <span className="font-mono text-xs text-ink-3 tabular-nums">
                [{item.count}]
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
