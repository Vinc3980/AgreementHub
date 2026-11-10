'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Field } from './field';

const CONTROL =
  'block w-full min-h-11 rounded-control border border-rule-strong bg-sheet px-3 py-2 text-sm text-ink ' +
  'placeholder:text-ink-3 transition-colors duration-[var(--duration-ui)] ' +
  'hover:border-ink-3 focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/30 ' +
  'disabled:cursor-not-allowed disabled:bg-vellum disabled:text-ink-2';

export interface SearchableOption {
  value: string;
  label: string;
  keywords?: string;
}

export function SearchableSelect({
  label,
  hint,
  error,
  required,
  value,
  options,
  placeholder = 'Search…',
  onChange,
  disabled,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  value: string;
  options: SearchableOption[];
  placeholder?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      const hay = `${o.label} ${o.value} ${o.keywords ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function commit(next: string) {
    onChange(next);
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      setActiveIndex(0);
      e.preventDefault();
      return;
    }
    if (!open) return;
    if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setActiveIndex((i) => Math.max(i - 1, 0));
      e.preventDefault();
    } else if (e.key === 'Enter') {
      const opt = filtered[activeIndex] ?? (filtered.length === 1 ? filtered[0] : undefined);
      if (opt) {
        commit(opt.value);
        e.preventDefault();
      }
    }
  }

  const displayValue = open ? query : selected?.label ?? '';

  const control = (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        disabled={disabled}
        required={required && !value}
        className={`${CONTROL} ${error ? 'border-danger' : ''} pr-9`}
        placeholder={placeholder}
        value={displayValue}
        onFocus={() => {
          setOpen(true);
          setQuery('');
          setActiveIndex(Math.max(0, filtered.findIndex((o) => o.value === value)));
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Toggle options"
        className="absolute inset-y-0 right-0 flex items-center px-3 text-ink-3 hover:text-ink"
        onClick={() => {
          setOpen((o) => !o);
          inputRef.current?.focus();
        }}
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-control border border-rule bg-sheet py-1 shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-ink-3">No matches</li>
          ) : (
            filtered.map((opt, i) => {
              const active = i === activeIndex;
              const sel = opt.value === value;
              return (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={sel}
                  className={[
                    'cursor-pointer px-3 py-2 text-sm',
                    active ? 'bg-vellum text-ink' : 'text-ink',
                    sel ? 'font-medium' : '',
                  ].join(' ')}
                  onMouseEnter={() => setActiveIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(opt.value);
                  }}
                >
                  {opt.label}
                </li>
              );
            })
          )}
        </ul>
      ) : null}
      {/* keep form value for native required validation contexts where useful */}
      <input type="hidden" name={id} value={value} />
    </div>
  );

  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={id}>
      {control}
    </Field>
  );
}
