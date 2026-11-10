'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState, CardSkeleton } from '@/components/ui/states';
import { useObligationsOverview } from '@/lib/queries';
import { formatDate, obligationStatusLabel, obligationStatusTone } from '@/lib/format';

type StatusFilter = '' | 'UPCOMING' | 'DUE_SOON' | 'OVERDUE' | 'COMPLETED' | 'CANCELLED';
type AssignedFilter = '' | 'me' | 'others' | 'all';

export default function ObligationsPage() {
  const [status, setStatus] = useState<StatusFilter>('');
  const [assigned, setAssigned] = useState<AssignedFilter>('');
  const [dueFrom, setDueFrom] = useState('');
  const [dueTo, setDueTo] = useState('');
  const { data, isPending, isError, refetch } = useObligationsOverview({
    status: status || undefined,
    assigned: assigned || undefined,
    dueFrom: dueFrom ? new Date(`${dueFrom}T00:00:00.000Z`).toISOString() : undefined,
    dueTo: dueTo ? new Date(`${dueTo}T23:59:59.999Z`).toISOString() : undefined,
  });

  if (isPending) return <CardSkeleton rows={6} />;
  if (isError || !data) return <ErrorState description="Could not load obligations." onRetry={() => refetch()} />;

  const { obligations, summary } = data;
  const hasFilters = !!(status || assigned || dueFrom || dueTo);
  const upcoming = obligations.filter((o) => o.status === 'UPCOMING' || o.status === 'DUE_SOON');
  const overdue = obligations.filter((o) => o.status === 'OVERDUE');
  const completed = obligations.filter((o) => o.status === 'COMPLETED').slice(0, 20);

  return (
    <div className="flex flex-col gap-6 content-fade-in">
      <PageHeader title="Obligations" description="Upcoming responsibilities, overdue items, and completed obligations across agreements you can access." />

      <div className="grid grid-cols-2 gap-px border-y border-rule bg-rule sm:grid-cols-4">
        {[
          ['Upcoming', summary.upcoming],
          ['Overdue', summary.overdue],
          ['Assigned to me', summary.assignedToMe],
          ['Recently completed', summary.recentlyCompleted],
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-sheet px-4 py-4">
            <p className="text-caps text-ink-3">{label}</p>
            <p className={`mt-1 font-serif text-2xl tabular-nums ${label === 'Overdue' && Number(value) > 0 ? 'text-danger' : 'text-ink'}`}>{value as number}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b border-rule pb-4">
        <label className="text-sm">
          <span className="block text-xs text-ink-3">Status</span>
          <select className="mt-1 min-h-10 border border-rule-strong bg-sheet px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="">All statuses</option>
            <option value="UPCOMING">Upcoming</option>
            <option value="DUE_SOON">Due soon</option>
            <option value="OVERDUE">Overdue</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs text-ink-3">Assignment</span>
          <select className="mt-1 min-h-10 border border-rule-strong bg-sheet px-2 text-sm" value={assigned} onChange={(e) => setAssigned(e.target.value as AssignedFilter)}>
            <option value="">All</option>
            <option value="me">Assigned to me</option>
            <option value="others">Assigned to others</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs text-ink-3">Due from</span>
          <input type="date" className="mt-1 min-h-10 border border-rule-strong bg-sheet px-2 text-sm" value={dueFrom} onChange={(e) => setDueFrom(e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="block text-xs text-ink-3">Due to</span>
          <input type="date" className="mt-1 min-h-10 border border-rule-strong bg-sheet px-2 text-sm" value={dueTo} onChange={(e) => setDueTo(e.target.value)} />
        </label>
        {hasFilters ? (
          <button type="button" className="min-h-10 px-3 text-sm font-medium text-navy hover:underline" onClick={() => { setStatus(''); setAssigned(''); setDueFrom(''); setDueTo(''); }}>
            Clear filters
          </button>
        ) : null}
        <p className="w-full text-xs text-ink-3">Showing obligations across agreements you can access. Filter by agreement from an agreement’s Obligations tab.</p>
      </div>

      {obligations.length === 0 ? (
        <EmptyState title="No obligations found" description="Obligations you can see will appear here. Add them on an agreement’s Obligations tab." />
      ) : (
        <div className="space-y-6">
          {overdue.length > 0 && !status ? (
            <Section title="Overdue" items={overdue} />
          ) : null}
          {!status ? <Section title="Upcoming & due soon" items={upcoming} /> : null}
          {!status ? <Section title="Recently completed" items={completed} /> : null}
          {status ? <Section title="Results" items={obligations} /> : null}
        </div>
      )}
    </div>
  );
}

function Section({ title, items }: { title: string; items: Array<any> }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 font-serif text-lg text-ink">{title}</h2>
      <ul className="border-y border-rule bg-sheet">
        {items.map((o) => (
          <li key={o.id} className="border-b border-rule px-4 py-3 last:border-b-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/agreements/${o.agreementId}`} className="text-sm font-medium text-ink hover:text-navy">{o.title}</Link>
                  <Badge tone={obligationStatusTone(o.status)}>{obligationStatusLabel(o.status)}</Badge>
                  {o.assignedToMe ? <span className="text-caps text-navy">Assigned to you</span> : null}
                  {o.needsReview ? <span className="text-caps text-attention">Review needed (newer version)</span> : null}
                </div>
                <p className="mt-0.5 text-xs text-ink-2">{o.agreementPublicId} · {o.agreementTitle}</p>
                <p className="mt-0.5 text-xs text-ink-3">Due {formatDate(o.dueAt)} · {o.responsibleName || o.responsibleLabel || 'Unassigned'}{o.governingVersionNumber ? ` · v${o.governingVersionNumber}` : ''}</p>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
