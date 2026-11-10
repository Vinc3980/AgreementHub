'use client';

/**
 * Authenticated app shell: session guard + onboarding gate + the masthead.
 * There is no sidebar. Content sits on paper, under a single rule.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ApiError, get, post } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useToast } from '@/lib/toast';
import type { NotificationListResponse } from '@/lib/types';
import { Masthead, MobileBar } from '@/components/layout/nav';
import { Rosette } from '@/components/ui/rosette';

export function useUnreadCount() {
  return useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => get<NotificationListResponse>('/notifications?unread=true&limit=1'),
    refetchInterval: 60_000,
    select: (data) => data.counts.unread,
  });
}

/** Non-blocking nudge until the address is confirmed. Compact, dismissible per session. */
function EmailVerificationBanner() {
  const { user } = useSession();
  const [sending, setSending] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [devMode, setDevMode] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (dismissed) return null;

  async function resend() {
    setSending(true);
    setError(null);
    try {
      const res = await post<{
        ok: boolean;
        sent?: boolean;
        alreadyVerified?: boolean;
        devMode?: boolean;
      }>('/auth/verify-email/request');
      if (res.alreadyVerified) {
        setSentTo(null);
        setError('Your email is already verified. Refresh the page.');
      } else if (res.sent) {
        setSentTo(user?.email ?? 'your email address');
        setCooldown(60);
        setDevMode(Boolean(res.devMode));
      } else {
        setError('The verification email could not be sent. Try again.');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const seconds = err.retryAfterSeconds ?? 60;
        setCooldown(Math.max(1, Math.ceil(seconds)));
        setError(`Please wait ${Math.max(1, Math.ceil(seconds))} seconds before sending another link.`);
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not send the verification email. Try again.');
      }
    } finally {
      setSending(false);
    }
  }

  const label = sending
    ? 'Sending…'
    : cooldown > 0
      ? `Resend in ${cooldown}s`
      : sentTo
        ? 'Send another link'
        : 'Resend verification email';

  return (
    <div className="border-b border-attention-rule bg-attention-tint">
      <div className="mx-auto flex w-full max-w-[88rem] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 text-sm sm:px-6">
        <span className="min-w-0 flex-1 text-ink">
          <span className="text-caps text-attention">Unverified</span>{' '}
          Verify your email address to accept invitations sent to you.
          {sentTo ? <span className="block text-xs text-seal">Sent to {sentTo}.</span> : null}
          {devMode && sentTo ? (
            <span className="block text-xs text-ink-3">
              Dev mode: the link is in the API terminal.
            </span>
          ) : null}
          {error ? (
            <span className="block text-xs text-danger" role="alert">
              {error}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => void resend()}
          disabled={sending || cooldown > 0}
          aria-busy={sending || undefined}
          className="min-h-11 border border-attention-rule bg-sheet px-3 text-xs font-medium text-ink hover:bg-paper disabled:opacity-60"
        >
          {label}
        </button>
        <Link
          href="/settings?tab=profile"
          className="text-xs font-medium text-attention underline underline-offset-2"
        >
          Settings
        </Link>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="min-h-11 px-2 text-xs text-ink-3 hover:text-ink"
          aria-label="Dismiss verification reminder for this session"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const { status, user } = useSession();
  const unread = useUnreadCount();
  const gateShownAt = useRef(Date.now());
  const [gateReady, setGateReady] = useState(false);

  const onboardingIncomplete =
    status === 'authenticated' && user && !user.onboardingCompletedAt;

  const gated =
    !gateReady ||
    status === 'loading' ||
    status === 'unauthenticated' ||
    Boolean(onboardingIncomplete);

  useEffect(() => {
    if (status === 'loading') return;
    const elapsed = Date.now() - gateShownAt.current;
    const remaining = Math.max(0, 500 - elapsed);
    const timer = setTimeout(() => {
      setGateReady(true);
      if (status === 'unauthenticated') {
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      } else if (onboardingIncomplete && pathname !== '/onboarding') {
        router.replace('/onboarding');
      }
    }, remaining);
    return () => clearTimeout(timer);
  }, [status, onboardingIncomplete, pathname, router]);

  if (gated) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-paper"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="flex flex-col items-center gap-4">
          <Rosette hash="loading" size={56} className="text-seal" decorative drawing />
          <p className="text-caps text-ink-3">Opening the register…</p>
          <span className="sr-only">Checking your session</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-paper content-fade-in">
      <div className="no-print">
        <Masthead unread={unread.data ?? 0} />
        {user && !user.emailVerifiedAt && pathname !== '/settings' ? (
          <EmailVerificationBanner />
        ) : null}
      </div>

      <main className="mx-auto w-full max-w-[88rem] flex-1 px-4 py-7 pb-24 sm:px-6 sm:py-9 lg:pb-12">
        {children}
      </main>

      <footer className="mt-auto hidden border-t border-rule lg:block">
        <div className="mx-auto flex w-full max-w-[88rem] flex-wrap items-center justify-between gap-2 px-6 py-4 text-xs text-ink-3">
          <span>
            Every version is content-addressed. Public verification never reveals document contents.
          </span>
          <Link href="/" className="underline underline-offset-2 hover:text-ink">
            Public verification
          </Link>
        </div>
      </footer>

      <MobileBar />
    </div>
  );
}
