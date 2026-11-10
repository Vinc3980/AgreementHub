/** Shared shell for login/register/password pages. */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { RosetteMark } from '@/components/ui/rosette';

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5" aria-label="AgreementHub home">
            <RosetteMark size={24} className="text-ink" />
            <span className="font-serif text-[1.05rem] font-medium text-ink">AgreementHub</span>
          </Link>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-10 sm:py-16">
        <div className="w-full max-w-md">
          <div className="border border-rule bg-sheet px-6 py-7 sm:px-8">
            <p className="text-caps text-ink-3">The instrument</p>
            <h1 className="mt-2 font-serif text-xl text-ink">{title}</h1>
            {subtitle ? <p className="mt-1.5 text-sm text-ink-2">{subtitle}</p> : null}
            <div className="mt-6">{children}</div>
          </div>
          {footer ? <div className="mt-5 text-center text-sm text-ink-2">{footer}</div> : null}
        </div>
      </main>

      <footer className="border-t border-rule">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-ink-3 sm:px-6">
          <span>Hash-sealed records · append-only audit trail</span>
          <Link href="/verify/AGR-GH-2026-000001" className="underline underline-offset-2 hover:text-ink">
            Public verification
          </Link>
        </div>
      </footer>
    </div>
  );
}
