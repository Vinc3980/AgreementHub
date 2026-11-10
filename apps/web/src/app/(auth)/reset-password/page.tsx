'use client';

import Link from 'next/link';
import { Suspense, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { AuthShell } from '../AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { ApiError, post } from '@/lib/api';

function ResetForm() {
  const params = useSearchParams() ?? new URLSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setFieldErrors({ confirm: 'Passwords do not match.' });
      return;
    }
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      await post('/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.status === 400 && err.code !== 'VALIDATION_FAILED' ? err.message : err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Something went wrong. Please try again.');
      }
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <AuthShell
        title="Reset your password"
        footer={
          <Link href="/forgot-password" className="font-medium text-navy hover:underline">
            Request a new link
          </Link>
        }
      >
        <div
          className="rounded-control border border-danger-rule bg-danger-tint px-3 py-3 text-sm text-danger"
          role="alert"
        >
          This reset link is missing its token. Request a new one from the forgot-password page.
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell
        title="Password updated"
        footer={
          <Link href="/login" className="font-medium text-navy hover:underline">
            Sign in
          </Link>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-control border border-seal-rule bg-seal-tint px-3 py-3 text-sm text-ink">
            Your password has been changed and all existing sessions were signed out. Use your new
            password to sign in.
          </div>
          <Link
            href="/login"
            className="inline-flex h-10 items-center justify-center rounded-control bg-navy px-4 text-sm font-medium text-sheet hover:bg-navy-hover"
          >
            Go to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="For security, all existing sessions will be signed out after the change."
      footer={
        <Link href="/login" className="font-medium text-navy hover:underline">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
          hint="At least 10 characters, including letters and numbers."
          placeholder="••••••••••"
        />
        <Input
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={fieldErrors.confirm}
          placeholder="••••••••••"
        />
        {error ? (
          <div
            className="rounded-control border border-danger-rule bg-danger-tint px-3 py-2.5 text-sm text-danger"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        <Button type="submit" loading={loading} icon={<KeyRound className="h-4 w-4" />}>
          Update password
        </Button>
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
