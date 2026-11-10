'use client';

/** Dropdown menu (click-outside + ESC to close). Floating layer only. */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Dropdown({
  trigger,
  children,
  align = 'end',
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open ? (
        <div
          role="menu"
          className={`absolute z-30 mt-1 min-w-48 rounded-overlay border border-rule-strong bg-sheet p-1 ${
            align === 'end' ? 'right-0' : 'left-0'
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  onClick,
  children,
  danger = false,
  href,
}: {
  onClick?: () => void;
  children: ReactNode;
  danger?: boolean;
  href?: string;
}) {
  const cls = [
    'flex min-h-10 w-full items-center gap-2 rounded-control px-3 py-2 text-left text-sm',
    danger ? 'text-danger hover:bg-danger-tint' : 'text-ink hover:bg-vellum',
  ].join(' ');
  if (href) {
    return (
      <a className={cls} href={href} onClick={onClick} download role="menuitem">
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick} role="menuitem">
      {children}
    </button>
  );
}
