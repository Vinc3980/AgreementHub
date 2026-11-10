'use client';

/**
 * Onboarding: collected right after registration (name, phone, country,
 * region, optional organization, user type). Ghana-first defaults.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Briefcase, Building2, User, UserRound } from 'lucide-react';
import { COUNTRIES, GH_REGIONS } from '@agreementhub/domain/location';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { PhoneField } from '@/components/ui/phone-field';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Rosette, RosetteMark } from '@/components/ui/rosette';
import { ApiError, patch } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useToast } from '@/lib/toast';
import type { SessionResponse, UserType } from '@/lib/types';

const USER_TYPE_OPTIONS: Array<{
  value: UserType;
  label: string;
  description: string;
  icon: typeof User;
}> = [
  { value: 'INDIVIDUAL', label: 'Individual', description: 'Personal agreements', icon: User },
  {
    value: 'FREELANCER',
    label: 'Freelancer',
    description: 'Client work and contracts',
    icon: UserRound,
  },
  {
    value: 'SMALL_BUSINESS',
    label: 'Small business',
    description: 'Running a small company',
    icon: Briefcase,
  },
  {
    value: 'PROFESSIONAL',
    label: 'Professional',
    description: 'Advisor, agent, or consultant',
    icon: UserRound,
  },
  {
    value: 'ORGANIZATION',
    label: 'Organization',
    description: 'Team or company workspace',
    icon: Building2,
  },
];



export default function OnboardingPage() {
  const router = useRouter();
  const toast = useToast();
  const { user, status, refresh } = useSession();

  const countryOptions = useMemo(
    () => COUNTRIES.map((c) => ({ value: c.code, label: c.name })),
    [],
  );

  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [countryCode, setCountryCode] = useState('GH');
  const [region, setRegion] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [userType, setUserType] = useState<UserType | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  // Guard: onboarding requires a session.
  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login?next=/onboarding');
  }, [status, router]);

  // Prefill from the session once it loads.
  useEffect(() => {
    if (!user) return;
    setDisplayName((v) => v || user.displayName);
    setPhone((v) => v || (user.phone ?? ''));
    setCountryCode((v) => (v && v !== 'GH' ? v : user.countryCode ?? user.country ?? 'GH'));
    setRegion((v) => v || (user.region ?? ''));
    setOrganizationName((v) => v || (user.organizationName ?? ''));
    setUserType((v) => v || ((user.userType as UserType) ?? ''));
  }, [user]);

  useEffect(() => {
    if (countryCode !== 'GH') setRegion('');
  }, [countryCode]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      await patch<SessionResponse>('/users/me', {
        displayName: displayName.trim(),
        phone: phone.trim(),
        countryCode: countryCode.trim(),
        region: region.trim(),
        organizationName: organizationName.trim(),
        userType: userType || undefined,
        completeOnboarding: true,
      });
      await refresh();
      toast.success('Profile saved. Welcome to AgreementHub.');
      router.replace('/dashboard');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Something went wrong. Please try again.');
      }
      setLoading(false);
    }
  }

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper" role="status" aria-live="polite" aria-busy="true">
        <div className="flex flex-col items-center gap-3">
          <Rosette hash="loading" size={48} className="text-seal" decorative drawing />
          <span className="sr-only">Loading</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-rule bg-sheet">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-2.5 px-4 sm:px-6">
          <RosetteMark size={24} className="text-ink" />
          <span className="font-serif text-[1.05rem] font-medium text-ink">AgreementHub</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="rounded-panel border border-rule bg-sheet p-6 sm:p-8">
          <p className="text-caps text-ink-3">Before you begin</p>
          <h1 className="mt-2 font-serif text-xl text-ink">
            Tell us a bit about yourself
          </h1>
          <p className="mt-1.5 text-sm text-ink-2">
            This tailors your workspace. We only ask for basics: no sensitive financial or identity
            documents.
          </p>

          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-5" noValidate>
            <div className="grid gap-5 sm:grid-cols-2">
              <Input
                label="Full name"
                autoComplete="name"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                error={fieldErrors.displayName}
                placeholder="Ama Mensah"
              />
              <Input
                label="Email"
                value={user?.email ?? ''}
                readOnly
                hint="Verified at registration."
                className="bg-paper text-ink-2"
              />
              <div className="sm:col-span-2">
                <PhoneField
                  label="Phone"
                  value={phone}
                  onChange={setPhone}
                  error={fieldErrors.phone}
                  hint="Optional; used for signing notifications. Default +233 (Ghana). e.g. 024 123 4567"
                  defaultCountry={countryCode || 'GH'}
                />
              </div>
              <SearchableSelect
                label="Country"
                required
                value={countryCode}
                options={countryOptions}
                onChange={setCountryCode}
                error={fieldErrors.countryCode ?? fieldErrors.country}
                placeholder="Search countries…"
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
            </div>

            <div>
              <p className="text-sm font-medium text-ink">
                I mostly use AgreementHub as a<span className="text-danger"> *</span>
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {USER_TYPE_OPTIONS.map((opt) => {
                  const active = userType === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setUserType(opt.value)}
                      aria-pressed={active}
                      className={[
                        'flex items-start gap-3 rounded-panel border px-3.5 py-3 text-left transition-colors',
                        active
                          ? 'border-navy bg-navy-tint'
                          : 'border-rule-strong bg-sheet hover:bg-paper',
                      ].join(' ')}
                    >
                      <opt.icon
                        className={`mt-0.5 h-4 w-4 shrink-0 ${active ? 'text-navy' : 'text-ink-3'}`}
                        aria-hidden
                      />
                      <span>
                        <span className="block text-sm font-medium text-ink">{opt.label}</span>
                        <span className="mt-0.5 block text-xs text-ink-2">{opt.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {fieldErrors.userType ? (
                <p className="mt-1.5 text-sm text-danger" role="alert">
                  {fieldErrors.userType}
                </p>
              ) : null}
            </div>

            {error ? (
              <div
                className="rounded-control border border-danger-rule bg-danger-tint px-3 py-2.5 text-sm text-danger"
                role="alert"
              >
                {error}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-5">
              <p className="text-xs text-ink-3">You can change these anytime in Settings.</p>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  onClick={() => router.replace('/dashboard')}
                  type="button"
                >
                  Skip for now
                </Button>
                <Button type="submit" loading={loading} loadingLabel="Saving…">
                  Save and continue
                </Button>
              </div>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
