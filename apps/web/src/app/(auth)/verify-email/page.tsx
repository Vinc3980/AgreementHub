'use client';

/**
 * Email verification landing page. The token arrives by email and is consumed
 * exactly once; the API decides whether it is valid, unexpired, and unused.
 */
import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, MailCheck, ShieldX } from 'lucide-react';
import { AuthShell } from '../AuthShell';
import { Button } from '@/components/ui/button';
import { ApiError, post } from '@/lib/api';
import { useSession } from '@/lib/session';

type VerifyState =
  | { kind: 'verifying' }
  | { kind: 'success' }
  | { kind: 'error'; message: string; expiredOrInvalid: boolean };

function VerifyEmailContent() {
  const params = useSearchParams() ?? new URLSearchParams();
  const token = params.get('token') ?? '';
  const { status, refresh } = useSession();
  const [state, setState] = useState<VerifyState>({ kind: 'verifying' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (!token) {
      setState({
        kind: 'error',
        expiredOrInvalid: true,
        message: 'This verification link is missing its token. Request a new verification email.',
      });
      return;
    }

    void (async () => {
      try {
        await post('/auth/verify-email/confirm', { token });
        setState({ kind: 'success' });
        if (status === 'authenticated') await refresh();
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : 'We could not verify this link. Request a new verification email.';
        const expiredOrInvalid =
          !(err instanceof ApiError) || err.code === 'INVALID_VERIFICATION_TOKEN' || err.status === 400;
        setState({ kind: 'error', message, expiredOrInvalid });
      }
    })();
  }, [token, status, refresh]);

  if (state.kind === 'verifying') {
    return (
      <AuthShell title="Verifying your email" subtitle="This only takes a moment.">
        <p className="flex items-center gap-2 text-sm text-ink-2" role="status" aria-live="polite">
          <MailCheck className="h-4 w-4 text-navy" aria-hidden />
          Checking your verification link…
        </p>
      </AuthShell>
    );
  }

  if (state.kind === 'success') {
    return (
      <AuthShell
        title="Email verified"
        footer={
          status === 'authenticated' ? (
            <Link href="/dashboard" className="font-medium text-navy hover:underline">
              Go to your dashboard
            </Link>
          ) : (
            <Link href="/login" className="font-medium text-navy hover:underline">
              Sign in
            </Link>
          )
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2 rounded-control border border-seal-rule bg-seal-tint px-3 py-3 text-sm text-ink">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-seal" aria-hidden />
            <span>
              Your email address is confirmed. You can now accept agreement invitations sent to
              this address.
            </span>
          </div>
          <Link href={status === 'authenticated' ? '/dashboard' : '/login'}>
            <Button className="w-full">
              {status === 'authenticated' ? 'Go to dashboard' : 'Sign in'}
            </Button>
          </Link>
        </div>
      </AuthShell>
    );
  }

  const nextStepHref = status === 'authenticated' ? '/settings?tab=profile' : '/login';
  const nextStepLabel =
    status === 'authenticated' ? 'Send a new link' : 'Sign in to send a new link';

  return (
    <AuthShell
      title={state.expiredOrInvalid ? 'Verification link expired or invalid' : 'Verification problem'}
      footer={
        <Link href={nextStepHref} className="font-medium text-navy hover:underline">
          {nextStepLabel}
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        <div
          className="flex items-start gap-2 rounded-control border border-danger-rule bg-danger-tint px-3 py-3 text-sm text-danger"
          role="alert"
        >
          <ShieldX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{state.message}</span>
        </div>
        <p className="text-sm text-ink-2">
          Verification links expire after 24 hours and can only be used once. Request a fresh link
          and open the newest email.
        </p>
        <Link href={nextStepHref}>
          <Button variant="secondary" className="w-full">
            {nextStepLabel}
          </Button>
        </Link>
      </div>
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  );
}
