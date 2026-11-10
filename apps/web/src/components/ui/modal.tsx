'use client';

/** Accessible dialog (ESC + backdrop close, focus on open). Floating layer only. */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  panelClassName,
  titleClassName,
  bodyClassName,
  footerClassName,
  backdropClassName,
  headerDivider = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  panelClassName?: string;
  titleClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
  backdropClassName?: string;
  headerDivider?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const width = size === 'lg' ? 'max-w-3xl' : size === 'sm' ? 'max-w-md' : 'max-w-lg';

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center" role="presentation">
      <div
        className={backdropClassName ?? 'absolute inset-0 bg-ink/45'}
        onClick={onClose}
        role="presentation"
        aria-hidden
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={
          panelClassName ??
          `relative z-10 max-h-[92vh] w-full ${width} overflow-y-auto rounded-overlay border border-rule-strong bg-sheet outline-none`
        }
      >
        <div
          className={`flex items-start justify-between gap-4 px-5 py-4 ${headerDivider ? 'border-b border-rule' : ''}`}
        >
          <div className="min-w-0">
            <h2 id={titleId} className={titleClassName ?? 'text-lg text-ink'}>
              {title}
            </h2>
            {description ? (
              <p className="mt-1 max-w-prose text-sm text-ink-2">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-vellum hover:text-ink"
            aria-label="Close dialog"
          >
            <X className="h-5 w-5" strokeWidth={1.5} />
          </button>
        </div>
        <div className={bodyClassName ?? 'px-5 py-4'}>{children}</div>
        {footer ? (
          <div
            className={
              footerClassName ??
              'flex flex-wrap justify-end gap-2 border-t border-rule bg-paper px-5 py-3'
            }
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
