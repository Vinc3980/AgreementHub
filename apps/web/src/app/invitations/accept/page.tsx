'use client';

import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, TicketCheck } from 'lucide-react';
import { AuthShell } from '../../(auth)/AuthShell';
import { Button } from '@/components/ui/button';
import { ApiError, post } from '@/lib/api';
import { useSession } from '@/lib/session';

function AcceptInvitation() {
  const router = useRouter();
  const params = useSearchParams();
  const { status } = useSession();
  const tokenFromUrl = (params.get('token') ?? '').trim();
  const tokenRef = useRef<string | null>(null);
  if (tokenFromUrl && !tokenRef.current) tokenRef.current = tokenFromUrl;
  const token = tokenRef.current ?? '';
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [agreementId, setAgreementId] = useState<string | null>(null);

  useEffect(() => {
    if (!tokenFromUrl) return;
    if (status === 'unauthenticated') {
      const next = `/invitations/accept?token=${encodeURIComponent(tokenFromUrl)}`;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    // Once authenticated (or terminal for this page), remove the token from the
    // address bar/history to reduce leakage via screenshots, referrers, or logs.
    if (status === 'authenticated' && typeof window !== 'undefined') {
      window.history.replaceState(null, '', '/invitations/accept');
    }
  }, [status, tokenFromUrl, router]);

  useEffect(() => {
    // Successful acceptance no longer needs the token; ensure URL stays clean.
    if (state === 'done' && typeof window !== 'undefined') {
      window.history.replaceState(null, '', '/invitations/accept');
    }
  }, [state]);

  async function accept() {
    if (!token) return;
    setState('working');
    setMessage(null);
    try {
      const res = await post<{ party?: { agreementId?: string }; agreement?: { id?: string } }>(
        '/parties/accept-invitation',
        { token },
      );
      const id = res?.agreement?.id ?? res?.party?.agreementId ?? null;
      setAgreementId(id);
      setState('done');
      setMessage('Invitation accepted. You now have access to this agreement.');
    } catch (err) {
      setState('error');
      setMessage(err instanceof ApiError ? err.message : 'Could not accept the invitation.');
    }
  }

  if (!token) {
    return (
      <AuthShell title="Invitation link invalid" subtitle="This invitation link is missing its token.">
        <p className="text-sm text-ink-2">Ask the sender to share the invitation again, or paste the token in the agreement’s Parties tab after signing in.</p>
        <div className="mt-4">
          <Link href="/login" className="text-sm font-medium text-navy hover:underline">Sign in</Link>
        </div>
      </AuthShell>
    );
  }

  if (status === 'loading' || status === 'unauthenticated') {
    return (
      <AuthShell title="Accept invitation" subtitle="Sign in to accept this invitation.">
        <p className="text-sm text-ink-2">Redirecting to sign in…</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={state === 'done' ? 'Invitation accepted' : 'Accept invitation'}
      subtitle={
        state === 'done'
          ? 'Your access has been linked.'
          : 'Review and accept this invitation. Only accept invitations you were expecting.'
      }
    >
      <div className="space-y-4">
        {state === 'done' ? (
          <div className="flex items-start gap-3 rounded-control border border-seal-rule bg-seal-tint px-3 py-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-seal" aria-hidden />
            <p className="text-sm text-ink">{message}</p>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-control border border-rule-strong bg-navy-tint px-3 py-3">
            <TicketCheck className="mt-0.5 h-5 w-5 shrink-0 text-navy" aria-hidden />
            <div className="text-sm text-ink-2">
              <p className="font-medium text-ink">Secure invitation link</p>
              <p className="mt-1">This link can grant access to the invited agreement. It may expire or be single-use. It is not a password or general sign-in method.</p>
            </div>
          </div>
        )}

        {state === 'error' && message ? (
          <div className="rounded-control border border-danger-rule bg-danger-tint px-3 py-2.5 text-sm text-danger" role="alert">
            {message}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {state !== 'done' ? (
            <Button onClick={accept} loading={state === 'working'} icon={<TicketCheck className="h-4 w-4" />}>
              Accept invitation
            </Button>
          ) : null}
          {agreementId ? (
            <Button variant={state === 'done' ? 'primary' : 'secondary'} onClick={() => router.push(`/agreements/${agreementId}`)}>
              Open agreement
            </Button>
          ) : (
            <Link href="/dashboard" className="text-sm font-medium text-navy hover:underline">
              Go to dashboard
            </Link>
          )}
        </div>

        <p className="text-xs text-ink-3">
          If you received this link by WhatsApp or email, make sure it came from someone you trust and was intended for you.
        </p>
      </div>
    </AuthShell>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense>
      <AcceptInvitation />
    </Suspense>
  );
}
