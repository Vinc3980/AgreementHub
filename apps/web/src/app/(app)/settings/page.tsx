'use client';

/** Settings: profile (onboarding data), security (password), active sessions. */
import { Suspense, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BellOff,
  CheckCircle2,
  KeyRound,
  LogOut,
  MailWarning,
  MonitorSmartphone,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { COUNTRIES, GH_REGIONS } from '@agreementhub/domain/location';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { PhoneField } from '@/components/ui/phone-field';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Badge } from '@/components/ui/badge';
import { CardSkeleton, EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states';
import { AvatarUploader } from '@/components/ui/avatar-uploader';
import { Tabs } from '@/components/ui/tabs';
import { useSessions } from '@/lib/queries';
import { revokeSession } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { useDelayedPending } from '@/lib/use-delayed-pending';
import { useToast } from '@/lib/toast';
import { ApiError, get, patch, post } from '@/lib/api';
import { formatDateTime, relativeTime } from '@/lib/format';
import { USER_TYPES, type NotificationPreferences, type UserType } from '@/lib/types';
import { LoadingStatus, staggerStyle } from '@/components/ui/states';

type SettingsTab = 'profile' | 'notifications' | 'security';

function ProfileForm() {
  const { user, refresh } = useSession();
  const toast = useToast();
  const countryOptions = useMemo(() => COUNTRIES.map((c) => ({ value: c.code, label: c.name })), []);

  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [region, setRegion] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [userType, setUserType] = useState<UserType | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [sendingVerification, setSendingVerification] = useState(false);

  useEffect(() => {
    if (!user) return;
    setDisplayName(user.displayName);
    setPhone(user.phone ?? '');
    setCountryCode(user.countryCode ?? (/^[A-Z]{2}$/.test(user.country ?? '') ? (user.country as string) : ''));
    setRegion(user.region ?? '');
    setOrganizationName(user.organizationName ?? '');
    setUserType((user.userType as UserType) ?? '');
  }, [user]);

  useEffect(() => {
    if (countryCode && countryCode !== 'GH') setRegion((r) => r); // keep non-GH region text
    if (countryCode !== 'GH' && GH_REGIONS.includes(region as any)) setRegion('');
  }, [countryCode, region]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      await patch('/users/me', {
        displayName: displayName.trim(),
        phone: phone.trim(),
        countryCode: countryCode.trim(),
        region: region.trim(),
        organizationName: organizationName.trim(),
        userType: userType || undefined,
      });
      await refresh();
      toast.success('Profile updated.');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Could not save the profile.');
      }
    } finally {
      setSaving(false);
    }
  }

  async function onResendVerification() {
    setSendingVerification(true);
    try {
      const res = await post<{ ok: boolean; sent?: boolean; alreadyVerified?: boolean }>(
        '/auth/verification-email/resend',
      );
      if (res.alreadyVerified) {
        await refresh();
        toast.success('Your email is already verified.');
      } else {
        toast.success('Verification email sent. Check your inbox.');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the verification email.');
    } finally {
      setSendingVerification(false);
    }
  }

  return (
    <form onSubmit={onSave} className="space-y-5" noValidate>
      <AvatarUploader />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Full name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={fieldErrors.displayName}
          required
        />
        <Input label="Email" value={user?.email ?? ''} readOnly className="bg-paper text-ink-2" />
        <div className="sm:col-span-2">
          <PhoneField
            label="Phone"
            value={phone}
            onChange={setPhone}
            error={fieldErrors.phone}
            defaultCountry={countryCode || 'GH'}
            hint="Optional. e.g. 024 123 4567"
          />
        </div>
        <SearchableSelect
          label="Country"
          value={countryCode}
          options={countryOptions}
          onChange={setCountryCode}
          error={fieldErrors.countryCode ?? fieldErrors.country}
          placeholder="Search countries…"
          hint="Optional."
        />
        {countryCode === 'GH' ? (
          <Select
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            error={fieldErrors.region}
            hint="Optional."
          >
            <option value="">Select a region…</option>
            {GH_REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            label="Region / state"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            error={fieldErrors.region}
            hint="Optional."
            placeholder="Region or state"
          />
        )}
        <Input
          label="Business / organization"
          value={organizationName}
          onChange={(e) => setOrganizationName(e.target.value)}
          error={fieldErrors.organizationName}
          hint="Optional."
          placeholder="Kofi & Co."
          className="sm:col-span-2"
        />
        <Select
          label="User type"
          value={userType}
          onChange={(e) => setUserType(e.target.value as UserType | '')}
        >
          <option value="">Not set</option>
          {USER_TYPES.map((t) => (
            <option key={t} value={t}>
              {t
                .toLowerCase()
                .split('_')
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(' ')}
            </option>
          ))}
        </Select>
      </div>

      {error ? (
        <div className="rounded-control border border-danger-rule bg-danger-tint px-3 py-2.5 text-sm text-danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-4">
        <Button type="submit" loading={saving} loadingLabel="Saving…" icon={<Save className="h-4 w-4" />}>
          Save changes
        </Button>
        <span className="flex items-center gap-1.5 text-sm text-ink-2">
          {user?.emailVerifiedAt ? (
            <>
              <ShieldCheck className="h-4 w-4 text-seal" aria-hidden />
              Email verified {relativeTime(user.emailVerifiedAt)}
            </>
          ) : (
            <>
              <MailWarning className="h-4 w-4 text-attention" aria-hidden />
              Email not verified
            </>
          )}
        </span>
        {!user?.emailVerifiedAt ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={sendingVerification}
            loadingLabel="Sending…"
            onClick={onResendVerification}
          >
            Send verification email
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function ChangePasswordForm() {
  const toast = useToast();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await post('/auth/change-password', { currentPassword, newPassword });
      setDone(true);
      setCurrent('');
      setNew('');
      setConfirm('');
      toast.success('Password changed. Other sessions were signed out.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {done ? (
        <div className="flex items-center gap-2 rounded-control border border-seal-rule bg-seal-tint px-3 py-2.5 text-sm text-ink">
          <CheckCircle2 className="h-4 w-4 text-seal" aria-hidden />
          Password updated.
        </div>
      ) : null}
      <div className="grid gap-4 sm:max-w-md">
        <Input
          label="Current password"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(e) => setNew(e.target.value)}
          hint="At least 10 characters, including letters and numbers."
        />
        <Input
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      {error ? (
        <div className="rounded-control border border-danger-rule bg-danger-tint px-3 py-2.5 text-sm text-danger" role="alert">
          {error}
        </div>
      ) : null}
      <Button type="submit" loading={saving} loadingLabel="Changing…" icon={<KeyRound className="h-4 w-4" />}>
        Change password
      </Button>
    </form>
  );
}

const NOTIFICATION_OPTIONS: Array<{
  key: keyof Pick<NotificationPreferences, 'reminders' | 'comments' | 'activity' | 'email'>;
  label: string;
  description: string;
}> = [
  {
    key: 'reminders',
    label: 'Reminders',
    description: 'Signature reminders, approaching expiry dates and expired agreements.',
  },
  {
    key: 'comments',
    label: 'Comments',
    description: 'New comments and comment resolution updates on your agreements.',
  },
  {
    key: 'activity',
    label: 'Agreement activity',
    description: 'Status changes, signatures, amendments and completion updates.',
  },
  {
    key: 'email',
    label: 'Email delivery',
    description: 'Also send enabled notifications to your verified email address.',
  },
];

const OBLIGATION_DAY_OPTIONS = [
  { value: 7, label: '7 days before' },
  { value: 3, label: '3 days before' },
  { value: 1, label: '1 day before' },
  { value: 0, label: 'On due date' },
  { value: -1, label: '1 day after (overdue nudge)' },
  { value: -3, label: '3 days after' },
] as const;

function NotificationsForm() {
  const toast = useToast();
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const showPending = useDelayedPending(loading);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await get<{ preferences: NotificationPreferences }>(
          '/users/me/notification-preferences',
        );
        if (!cancelled) setPrefs(res.preferences);
      } catch {
        if (!cancelled) setError('Could not load notification preferences.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function savePatch(patchBody: Partial<NotificationPreferences>, key: string, optimistic: NotificationPreferences) {
    if (!prefs) return;
    const previous = prefs;
    setPrefs(optimistic);
    setSavingKey(key);
    setError(null);
    try {
      const res = await patch<{ preferences: NotificationPreferences }>(
        '/users/me/notification-preferences',
        patchBody,
      );
      setPrefs(res.preferences);
      toast.success('Notification preference saved.');
    } catch (err) {
      setPrefs(previous);
      toast.error(err instanceof ApiError ? err.message : 'Could not save the preference.');
    } finally {
      setSavingKey(null);
    }
  }

  async function toggle(key: keyof Pick<NotificationPreferences, 'reminders' | 'comments' | 'activity' | 'email' | 'obligationReminders'>) {
    if (!prefs) return;
    const nextValue = !prefs[key];
    await savePatch({ [key]: nextValue } as Partial<NotificationPreferences>, key, { ...prefs, [key]: nextValue });
  }

  async function toggleObligationDay(day: number) {
    if (!prefs) return;
    const current = prefs.obligationReminderDays ?? [7, 3, 1, 0, -1];
    const has = current.includes(day);
    const nextDays = (has ? current.filter((d) => d !== day) : [...current, day]).sort((a, b) => b - a);
    const safeDays = nextDays.length > 0 ? nextDays : [0];
    await savePatch({ obligationReminderDays: safeDays }, `ob-day-${day}`, { ...prefs, obligationReminderDays: safeDays });
  }

  if (loading) {
    if (!showPending) {
      return <div className="min-h-[10rem]" aria-busy="true" aria-live="polite"><LoadingStatus /></div>;
    }
    return <ListSkeleton rows={3} />;
  }
  if (error || !prefs) {
    return (
      <p className="text-sm text-danger" role="alert">
        {error ?? 'Notification preferences are unavailable.'}
      </p>
    );
  }

  const obligationReminders = prefs.obligationReminders ?? true;
  const obligationDays = prefs.obligationReminderDays ?? [7, 3, 1, 0, -1];

  return (
    <div className="space-y-4 content-fade-in">
      {NOTIFICATION_OPTIONS.map((option) => (
        <label
          key={option.key}
          className="flex cursor-pointer items-start gap-3 rounded-control border border-rule bg-sheet px-4 py-3"
        >
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-brand"
            checked={prefs[option.key]}
            disabled={savingKey === option.key}
            onChange={() => void toggle(option.key)}
          />
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-sm font-medium text-ink">
              {prefs[option.key] ? (
                <Bell className="h-3.5 w-3.5 text-seal" aria-hidden />
              ) : (
                <BellOff className="h-3.5 w-3.5 text-ink-3" aria-hidden />
              )}
              {option.label}
            </span>
            <span className="mt-0.5 block text-xs text-ink-2">{option.description}</span>
          </span>
        </label>
      ))}

      <div className="rounded-control border border-rule bg-sheet px-4 py-3">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-brand"
            checked={obligationReminders}
            disabled={savingKey === 'obligationReminders'}
            onChange={() => void toggle('obligationReminders')}
          />
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-sm font-medium text-ink">
              {obligationReminders ? (
                <Bell className="h-3.5 w-3.5 text-seal" aria-hidden />
              ) : (
                <BellOff className="h-3.5 w-3.5 text-ink-3" aria-hidden />
              )}
              Obligation reminders
            </span>
            <span className="mt-0.5 block text-xs text-ink-2">
              Post-signature reminders for payment deadlines, delivery milestones, renewals, and other responsibilities. Reminders are background-delivered and deduplicated; obligations are never marked completed automatically.
            </span>
          </span>
        </label>
        {obligationReminders ? (
          <fieldset className="mt-3 border-t border-rule pt-3">
            <legend className="text-caps text-ink-3">Reminder schedule</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {OBLIGATION_DAY_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 text-sm text-ink-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-brand"
                    checked={obligationDays.includes(opt.value)}
                    disabled={savingKey === `ob-day-${opt.value}`}
                    onChange={() => void toggleObligationDay(opt.value)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
      </div>

      <p className="text-xs text-ink-2">
        Invitations, approval requests and signature requests always notify you because they need
        your action. Account and security notices cannot be disabled.
      </p>
    </div>
  );
}

function SessionsCard() {
  const query = useSessions();
  const { logout } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [loggingOutAll, setLoggingOutAll] = useState(false);
  const showPending = useDelayedPending(query.isPending && !query.data);

  async function onRevoke(id: string, current: boolean) {
    setRevokeId(id);
    try {
      await revokeSession(id);
      if (current) {
        await logout();
        window.location.replace('/login');
        return;
      }
      toast.success('Session revoked.');
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not revoke the session.');
    } finally {
      setRevokeId(null);
    }
  }

  async function onLogoutAll() {
    setLoggingOutAll(true);
    try {
      await post('/auth/logout-all');
      window.location.replace('/login');
    } catch {
      toast.error('Could not sign out everywhere.');
      setLoggingOutAll(false);
    }
  }

  if (query.isPending) {
    if (!showPending) {
      return <div className="min-h-[8rem]" aria-busy="true" aria-live="polite"><LoadingStatus /></div>;
    }
    return <ListSkeleton rows={2} />;
  }
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />;

  const sessions = query.data?.sessions ?? [];

  return (
    <div className="space-y-4 content-fade-in">
      <ul className="divide-y divide-rule border-y border-rule bg-sheet">
        {sessions.map((s, i) => (
          <li key={s.id} className="stagger-item flex flex-wrap items-center gap-3 px-5 py-3.5" style={staggerStyle(i)}>
            <MonitorSmartphone className="h-5 w-5 shrink-0 text-ink-3" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">
                {s.userAgent
                  ? s.userAgent.replace(/\([^)]*\)/g, '').trim().slice(0, 60) || 'Unknown device'
                  : 'Unknown device'}
              </p>
              <p className="text-xs text-ink-2">
                Started {formatDateTime(s.createdAt)}
                {s.ip ? ` · IP ${s.ip}` : ''}
              </p>
            </div>
            {s.current ? (
              <Badge tone="success">This device</Badge>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                loading={revokeId === s.id}
                loadingLabel="Revoking…"
                onClick={() => onRevoke(s.id, false)}
              >
                Revoke
              </Button>
            )}
          </li>
        ))}
        {sessions.length === 0 ? (
          <li className="px-5 py-6">
            <EmptyState title="No active sessions" description="Sign in again to continue." />
          </li>
        ) : null}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-danger-rule bg-danger-tint px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-danger">Sign out everywhere</p>
          <p className="text-xs text-ink-2">Revokes every session, including this one.</p>
        </div>
        <Button
          variant="danger"
          loading={loggingOutAll}
          loadingLabel="Signing out…"
          icon={<LogOut className="h-4 w-4" />}
          onClick={onLogoutAll}
        >
          Logout all sessions
        </Button>
      </div>
    </div>
  );
}

function SettingsContent() {
  const search = useSearchParams() ?? new URLSearchParams();
  const tab = search.get('tab');
  const active = (tab === 'security' ? 'security' : tab === 'notifications' ? 'notifications' : 'profile') as SettingsTab;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader title="Settings" description="Your profile, notifications, security, and active sessions." />

      <Tabs<SettingsTab>
        ariaLabel="Settings sections"
        value={active}
        onChange={(value) => {
          // Next syncs useSearchParams with native history APIs.
          window.history.replaceState(
            null,
            '',
            value === 'profile' ? '/settings' : `/settings?tab=${value}`,
          );
        }}
        items={[
          { value: 'profile', label: 'Profile' },
          { value: 'notifications', label: 'Notifications' },
          { value: 'security', label: 'Security & sessions' },
        ]}
      />

      {active === 'profile' ? (
        <section className="border-y border-rule bg-sheet p-5">
          <h2 className="font-serif text-lg text-ink">Profile</h2>
          <p className="mt-0.5 mb-4 text-sm text-ink-2">
            Collected at onboarding; we deliberately store only the basics.
          </p>
          <ProfileForm />
        </section>
      ) : active === 'notifications' ? (
        <section className="border-y border-rule bg-sheet p-5">
          <h2 className="font-serif text-lg text-ink">Notification preferences</h2>
          <p className="mt-0.5 mb-4 text-sm text-ink-2">
            Choose what appears in your notification center and what we email you. Reminders are
            rate-limited so you are never spammed.
          </p>
          <NotificationsForm />
        </section>
      ) : (
        <div className="space-y-6">
          <section className="border-y border-rule bg-sheet p-5">
            <h2 className="font-serif text-lg text-ink">Change password</h2>
            <p className="mt-0.5 mb-4 text-sm text-ink-2">
              Changing your password signs out every other session.
            </p>
            <ChangePasswordForm />
          </section>
          <section className="border-y border-rule bg-sheet p-5">
            <h2 className="font-serif text-lg text-ink">Active sessions</h2>
            <p className="mt-0.5 mb-4 text-sm text-ink-2">
              Every device currently signed in to your account.
            </p>
            <SessionsCard />
          </section>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<CardSkeleton rows={4} />}>
      <SettingsContent />
    </Suspense>
  );
}
