'use client';

/** Your desk: counts as a ledger strip, a 90-day horizon, and what waits on you. */
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { StatusStamp } from '@/components/ui/status-stamp';
import { CardSkeleton, EmptyState, ErrorState, staggerStyle } from '@/components/ui/states';
import { Marginalia } from '@/components/ui/marginalia';
import { useAgreementList, useDashboard } from '@/lib/queries';
import { useDelayedPending } from '@/lib/use-delayed-pending';
import { useSession } from '@/lib/session';
import { ACTION_DESCRIPTIONS, ACTION_LABELS, DEFAULT_LOCALE, eventLabel, formatDate, relativeTime } from '@/lib/format';

const DAY = 86_400_000;

function CountCell({
  label,
  value,
  href,
  emphasis = false,
  note,
}: {
  label: string;
  value: number;
  href: string;
  emphasis?: boolean;
  note?: string;
}) {
  return (
    <Link
      href={href}
      className="group flex min-w-0 flex-col justify-between gap-3 border-l border-rule px-4 py-4 first:border-l-0 hover:bg-vellum/70"
    >
      <span className={`text-caps ${emphasis ? 'text-attention' : 'text-ink-3'}`}>{label}</span>
      <span
        className={`font-serif text-2xl leading-none tabular-nums ${
          emphasis && value > 0 ? 'text-attention' : 'text-ink'
        }`}
      >
        {value}
      </span>
      {note ? <span className="text-xs text-ink-3">{note}</span> : null}
    </Link>
  );
}

/** Ninety-day expiry horizon. Each mark is a dated document, not a chart. */
function Horizon() {
  const list = useAgreementList({ limit: 100 });
  const now = Date.now();
  const horizon = now + 90 * DAY;
  const expiring = (list.data?.agreements ?? [])
    .filter((a) => {
      if (!a.expiresAt) return false;
      const t = new Date(a.expiresAt).getTime();
      return t >= now && t <= horizon;
    })
    .sort((a, b) => new Date(a.expiresAt!).getTime() - new Date(b.expiresAt!).getTime())
    .slice(0, 40);

  const months = Array.from({ length: 4 }).map((_, i) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + i);
    return d;
  });

  return (
    <section className="border-y border-rule bg-sheet" aria-labelledby="horizon-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
        <h2 id="horizon-title" className="text-caps text-ink-3">
          Expiry horizon · next 90 days
        </h2>
        <span className="text-xs text-ink-3">
          {expiring.length === 0
            ? 'Nothing lapses in this window.'
            : `${expiring.length} agreement${expiring.length === 1 ? '' : 's'} lapse`}
        </span>
      </div>

      <div className="relative mx-5 mt-6 mb-9 h-12" role="img" aria-label="Agreements expiring over the next 90 days">
        <div className="absolute inset-x-0 top-5 h-px bg-rule-strong" />
        {months.map((m, i) => {
          const left = ((m.getTime() - now) / (90 * DAY)) * 100;
          return (
            <div key={i} className="absolute top-0" style={{ left: `${Math.max(0, left)}%` }}>
              <span className="block h-2 w-px bg-rule-strong" />
              <span className="mt-1 block -translate-x-1/2 text-2xs whitespace-nowrap text-ink-3">
                {m.toLocaleDateString(DEFAULT_LOCALE, { month: 'short' })}
              </span>
            </div>
          );
        })}
        {expiring.map((a) => {
          const left = Math.min(100, Math.max(0, ((new Date(a.expiresAt!).getTime() - now) / (90 * DAY)) * 100));
          return (
            <Link
              key={a.id}
              href={`/agreements/${a.id}`}
              title={`${a.title} (expires ${formatDate(a.expiresAt)})`}
              className="group absolute top-1.5 -translate-x-1/2"
              style={{ left: `${left}%` }}
            >
              <span className="block h-4 w-px bg-navy/60 group-hover:h-6 group-hover:bg-navy" />
              <span className="sr-only">{a.title}</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export default function DashboardPage() {
  const { user } = useSession();
  const { data, isPending, isError, refetch } = useDashboard();
  const showPending = useDelayedPending(isPending);

  if (isPending) {
    if (!showPending) {
      return <div className="min-h-[28rem]" aria-busy="true" aria-live="polite" />;
    }
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton rows={2} />
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <CardSkeleton rows={4} />
          </div>
          <div className="lg:col-span-2">
            <CardSkeleton rows={5} />
          </div>
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return <ErrorState description="We couldn't load your desk." onRetry={() => refetch()} />;
  }

  const { counts, pendingActions, recentActivity } = data;
  const firstName = user?.displayName?.split(' ')[0];
  const today = (() => {
    try {
      return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Africa/Accra',
      }).format(new Date());
    } catch {
      return new Intl.DateTimeFormat('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date());
    }
  })();

  return (
    <div className="flex flex-col gap-7 content-fade-in">
      <PageHeader
        title={firstName ? `Good day, ${firstName}` : 'Your desk'}
        description={today}
        actions={
          <Link href="/agreements/new">
            <Button>New agreement</Button>
          </Link>
        }
      />

      {counts.total === 0 ? (
        <section className="border-y border-rule bg-sheet px-5 py-6" aria-labelledby="first-steps-title">
          <p id="first-steps-title" className="text-caps text-ink-3">
            First steps
          </p>
          <ol className="mt-4 space-y-0 border-t border-rule">
            <li className="border-b border-rule">
              <Link
                href="/agreements/new"
                className="flex min-h-11 items-center justify-between gap-3 px-1 py-3 text-sm text-ink hover:bg-vellum/60"
              >
                <span>Create an agreement</span>
                <span className="text-caps text-ink-3" aria-hidden>
                  →
                </span>
              </Link>
            </li>
            <li className="border-b border-rule">
              <Link
                href="/agreements/new"
                className="flex min-h-11 items-center justify-between gap-3 px-1 py-3 text-sm text-ink hover:bg-vellum/60"
              >
                <span>Invite a counterparty</span>
                <span className="text-xs text-ink-3">From an agreement</span>
              </Link>
            </li>
            <li>
              <Link
                href="/"
                className="flex min-h-11 items-center justify-between gap-3 px-1 py-3 text-sm text-ink hover:bg-vellum/60"
              >
                <span>Try the verify page</span>
                <span className="text-caps text-ink-3" aria-hidden>
                  →
                </span>
              </Link>
            </li>
          </ol>
        </section>
      ) : (
        <>
          {/* Counts as one ruled ledger strip. */}
          <div className="grid grid-cols-2 border-y border-rule bg-sheet sm:grid-cols-3 lg:grid-cols-6">
            <CountCell label="All agreements" value={counts.total} href="/agreements" />
            <CountCell label="Drafts" value={counts.drafts} href="/agreements?status=DRAFT" />
            <CountCell
              label="Awaiting you"
              value={counts.awaitingAction}
              href="/agreements?pending=me"
              emphasis
              note={counts.awaitingAction > 0 ? 'Needs your input' : 'All clear'}
            />
            <CountCell label="Active" value={counts.active} href="/agreements?status=ACTIVE" />
            <CountCell
              label="Expiring"
              value={counts.expiring}
              href="/agreements?status=EXPIRING"
              note="Next 30 days"
            />
            <CountCell label="Expired" value={counts.expired} href="/agreements?status=EXPIRED" />
          </div>

          <Horizon />
        </>
      )}

      <div className="grid gap-7 lg:grid-cols-5">
        {/* What waits on you */}
        <section className="lg:col-span-3" aria-labelledby="pending-title">
          <div className="flex flex-wrap items-baseline justify-between gap-2 pb-3">
            <h2 id="pending-title" className="font-serif text-lg text-ink">
              Waiting on you
            </h2>
            <span className="text-xs text-ink-3">
              {pendingActions.length
                ? `${pendingActions.length} open`
                : 'Nothing is waiting on you'}
            </span>
          </div>

          {pendingActions.length === 0 ? (
            <EmptyState
              title="You're all caught up"
              description="Signatures, approvals, and reviews assigned to you will appear here."
              action={
                <Link href="/agreements">
                  <Button variant="secondary" size="sm">
                    Browse agreements
                  </Button>
                </Link>
              }
            />
          ) : (
            <ol className="border-y border-rule bg-sheet">
              {pendingActions.map((action, i) => (
                <li
                  key={`${action.agreementId}-${action.action}`}
                  className="stagger-item border-b border-rule last:border-b-0"
                  style={staggerStyle(i)}
                >
                  <Link
                    href={`/agreements/${action.agreementId}`}
                    className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-4 transition-colors hover:bg-vellum/60"
                  >
                    <span className="w-7 shrink-0 pt-0.5 font-mono text-xs text-ink-3 tabular-nums">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{action.title}</span>
                        <StatusStamp status={action.status} />
                      </span>
                      <span className="mt-1 block text-sm text-attention">
                        {ACTION_LABELS[action.action] ?? action.action}
                        <span className="text-ink-2">. {ACTION_DESCRIPTIONS[action.action]}</span>
                      </span>
                      <span className="mt-1 block font-mono text-2xs text-ink-3">
                        {action.publicId} · updated {relativeTime(action.updatedAt)}
                      </span>
                    </span>
                    <span className="self-center text-caps text-ink-3">Open →</span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* Recent activity */}
        <section className="lg:col-span-2" aria-labelledby="activity-title">
          <div className="flex flex-wrap items-baseline justify-between gap-2 pb-3">
            <h2 id="activity-title" className="font-serif text-lg text-ink">
              The register
            </h2>
            <Link href="/agreements" className="text-xs text-ink-2 underline underline-offset-2 hover:text-ink">
              All agreements
            </Link>
          </div>

          {recentActivity.length === 0 ? (
            <EmptyState
              title="No activity yet"
              description="Create your first agreement to start the audit trail."
            />
          ) : (
            <ol className="border-y border-rule bg-sheet">
              {recentActivity.map((event, i) => (
                <li
                  key={`${event.agreementId}-${event.occurredAt}-${i}`}
                  className="stagger-item border-b border-rule last:border-b-0"
                  style={staggerStyle(i)}
                >
                  <Link href={`/agreements/${event.agreementId}`} className="block px-4 py-3 hover:bg-vellum/60">
                    <p className="text-sm text-ink">
                      <span className="font-medium">{eventLabel(event.eventType)}</span>
                      <span className="text-ink-2"> · {event.actorLabel}</span>
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-2">{event.title}</p>
                    <p className="mt-0.5 font-mono text-2xs text-ink-3">
                      {event.publicId} · {relativeTime(event.occurredAt)}
                    </p>
                  </Link>
                </li>
              ))}
            </ol>
          )}

          <Marginalia label="Tamper-evident" className="mt-5">
            Every entry is hash-chained to the one before it. Removing or editing an event breaks the
            chain and fails verification.
          </Marginalia>
        </section>
      </div>

    </div>
  );
}
