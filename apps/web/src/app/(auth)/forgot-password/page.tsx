'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { MailCheck } from 'lucide-react';
import { AuthShell } from '../AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { ApiError, post } from '@/lib/api';
import type { ForgotPasswordResponse } from '@/lib/types';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState<ForgotPasswordResponse | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await post<ForgotPasswordResponse>('/auth/forgot-password', {
        email: email.trim(),
      });
      setSent(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <AuthShell
        title="Reset your password"
        footer={
          <Link href="/login" className="font-medium text-navy hover:underline">
            Back to sign in
          </Link>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3 rounded-control border border-rule-strong bg-navy-tint px-3 py-3">
            <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-navy" aria-hidden />
            <p className="text-sm text-ink">
              If an account exists for <b>{email}</b>, a reset link has been issued. The link
              expires in 30 minutes and can be used once.
            </p>
          </div>

          <Button variant="secondary" onClick={() => setSent(null)}>
            Send another link
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Forgot your password?"
      subtitle="Enter your account email and we’ll send a reset link."
      footer={
        <Link href="/login" className="font-medium text-navy hover:underline">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
        />
        {error ? (
          <div
            className="rounded-control border border-danger-rule bg-danger-tint px-3 py-2.5 text-sm text-danger"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        <Button type="submit" loading={loading}>
          Send reset link
        </Button>
      </form>
    </AuthShell>
  );
}
