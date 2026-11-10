'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import { AuthShell } from '../AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { ApiError, post } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function RegisterPage() {
  const router = useRouter();
  const { status, refresh } = useSession();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
  }, [status, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      await post('/auth/register', {
        displayName: displayName.trim(),
        email: email.trim(),
        password,
      });
      await refresh();
      router.replace('/onboarding');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'EMAIL_TAKEN') {
          setError('An account with this email already exists. Try signing in instead.');
        } else {
          setError(err.message);
        }
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Something went wrong. Please try again.');
      }
      setLoading(false);
    }
  }

  const passwordHint =
    'At least 10 characters, including letters and numbers.';

  return (
    <AuthShell
      title="Create your account"
      subtitle="Set up a secure workspace for your agreements."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-navy hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Input
          label="Full name"
          autoComplete="name"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={fieldErrors.displayName}
          placeholder="Jordan Rivera"
        />
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
          placeholder="you@company.com"
        />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
          hint={passwordHint}
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

        <Button type="submit" loading={loading} icon={<UserPlus className="h-4 w-4" />} className="w-full">
          Create account
        </Button>
        <p className="text-xs leading-relaxed text-ink-3">
          We only ask for the basics to run the service. Email is verified at registration in this
          build; no sensitive documents or payment details are collected.
        </p>
      </form>
    </AuthShell>
  );
}
