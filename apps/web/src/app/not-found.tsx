import Link from 'next/link';
import { RosetteMark } from '@/components/ui/rosette';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-4 text-center">
      <RosetteMark size={56} className="text-ink-3" />
      <p className="mt-5 font-mono text-sm text-ink-3">404</p>
      <h1 className="mt-2 font-serif text-2xl text-ink">Page not found</h1>
      <p className="mt-2 max-w-md text-sm text-ink-2">
        The page you’re looking for doesn’t exist or you don’t have access to it.
      </p>
      <div className="mt-6 flex gap-3">
        <Link
          href="/"
          className="inline-flex h-10 items-center rounded-control border border-rule-strong bg-sheet px-4 text-sm font-medium text-ink hover:bg-paper"
        >
          Go home
        </Link>
        <Link
          href="/dashboard"
          className="inline-flex h-10 items-center rounded-control bg-navy px-4 text-sm font-medium text-sheet hover:bg-navy-hover"
        >
          Dashboard
        </Link>
      </div>
    </div>
  );
}
