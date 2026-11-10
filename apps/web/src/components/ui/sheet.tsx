import type { ReactNode } from 'react';

/**
 * Sheet, the document surface. Square corners, hairline edge, generous
 * margins. The only place a watermark or a double rule may appear.
 */
export function Sheet({
  children,
  className = '',
  watermark,
  label,
}: {
  children: ReactNode;
  className?: string;
  watermark?: string;
  label?: string;
}) {
  return (
    <section
      className={`relative overflow-hidden rounded-none border border-rule bg-sheet ${className}`}
      aria-label={label}
    >
      {watermark ? (
        <span className="watermark" aria-hidden>
          {watermark}
        </span>
      ) : null}
      <div className="relative">{children}</div>
    </section>
  );
}

export function SheetHeader({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <header className={`border-b border-rule px-6 py-5 sm:px-8 ${className}`}>{children}</header>
  );
}

export function SheetBody({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`px-6 py-6 sm:px-8 ${className}`}>{children}</div>;
}

export function SheetFooter({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <footer className={`border-t border-rule px-6 py-4 sm:px-8 ${className}`}>{children}</footer>
  );
}
