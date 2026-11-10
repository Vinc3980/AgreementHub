'use client';

/**
 * Agreements register: ruled status tabs, a filter strip, then a table.
 * Filters live in the URL so every view is shareable.
 */
import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { FilePlus2, X } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState, ListSkeleton, LoadingStatus, staggerStyle } from '@/components/ui/states';
import { StatusStamp } from '@/components/ui/status-stamp';
import { RoleBadge } from '@/components/agreements/status-badge';
import { get } from '@/lib/api';
import { agreementQueryString, useAgreementList, useDashboard } from '@/lib/queries';
import { useDelayedPending } from '@/lib/use-delayed-pending';
import { useToast } from '@/lib/toast';
import { formatDate, relativeTime, ACTION_LABELS } from '@/lib/format';
import type { AgreementListResponse, PendingActionType } from '@/lib/types';

const TABS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'REVIEW', label: 'In review' },
  { value: 'NEGOTIATION', label: 'Negotiation' },
  { value: 'AWAITING_SIGNATURES', label: 'Awaiting signature' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'EXPIRING', label: 'Expiring' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'TERMINATED', label: 'Terminated' },
  { value: 'REJECTED', label: 'Rejected' },
];

const ROLE_OPTIONS = [
  { value: '', label: 'Any role' },
  { value: 'OWNER', label: 'Owner' },
  { value: 'CONTRIBUTOR', label: 'Contributor' },
  { value: 'REVIEWER', label: 'Reviewer' },
  { value: 'SIGNER', label: 'Signer' },
  { value: 'OBSERVER', label: 'Observer' },
];

const CATEGORY_OPTIONS = [
  { value: '', label: 'Any category' },
  { value: 'NDA', label: 'Non-disclosure' },
  { value: 'MSA', label: 'Master services' },
  { value: 'SOW', label: 'Statement of work' },
  { value: 'EMPLOYMENT', label: 'Employment' },
  { value: 'PARTNERSHIP', label: 'Partnership' },
  { value: 'LEASE', label: 'Lease' },
  { value: 'OTHER', label: 'Other' },
];

function toIso(date: string, endOfDay: boolean): string | undefined {
  if (!date) return undefined;
  return `${date}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
}

function AgreementsContent() {
  const router = useRouter();
  const params = useSearchParams() ?? new URLSearchParams();

  const status = params.get('status') ?? '';
  const category = params.get('category') ?? '';
  const role = params.get('role') ?? '';
  const q = params.get('q') ?? '';
  const dateFrom = params.get('dateFrom') ?? '';
  const dateTo = params.get('dateTo') ?? '';
  const pendingView = params.get('pending') === 'me';

  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => setSearchInput(q), [q]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (searchInput !== q) setParam('q', searchInput);
    }, 350);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'pending') next.delete('pending');
    router.replace(`/agreements?${next.toString()}`, { scroll: false });
  }

  function clearAll() {
    router.replace('/agreements', { scroll: false });
  }

  const listParams = useMemo(
    () => ({
      status: status || undefined,
      category: category || undefined,
      role: role || undefined,
      q: q || undefined,
      dateFrom: toIso(dateFrom, false),
      dateTo: toIso(dateTo, true),
      limit: 25,
    }),
    [status, category, role, q, dateFrom, dateTo],
  );

  const listQuery = useAgreementList(listParams, !pendingView);
  const dashboardQuery = useDashboard();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [loadingMore, setLoadingMore] = useState(false);
  const showListPending = useDelayedPending(listQuery.isPending && !listQuery.data);
  const showPendingViewPending = useDelayedPending(dashboardQuery.isPending && !dashboardQuery.data);

  const hasFilters = Boolean(status || category || role || q || dateFrom || dateTo);

  async function loadMore() {
    const cursor = listQuery.data?.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const json = await get<AgreementListResponse>(
        `/agreements${agreementQueryString({ ...listParams, cursor })}`,
      );
      queryClient.setQueryData<AgreementListResponse>(
        ['agreements', listParams],
        (old) =>
          old
            ? { agreements: [...old.agreements, ...json.agreements], nextCursor: json.nextCursor }
            : json,
      );
    } catch {
      toast.error('Could not load more agreements.');
    } finally {
      setLoadingMore(false);
    }
  }

  /* ------------------------------ pending view ----------------------------- */
  if (pendingView) {
    const pending = dashboardQuery.data?.pendingActions ?? [];
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Awaiting your action"
          description="Agreements with a decision, signature, or review waiting on you."
          breadcrumb={
            <Link href="/agreements" className="hover:text-ink">
              ← All agreements
            </Link>
          }
        />
        {dashboardQuery.isPending ? (
          showPendingViewPending ? (
            <ListSkeleton />
          ) : (
            <div className="min-h-[12rem]" aria-busy="true" aria-live="polite"><LoadingStatus /></div>
          )
        ) : dashboardQuery.isError ? (
          <ErrorState onRetry={() => dashboardQuery.refetch()} />
        ) : pending.length === 0 ? (
          <EmptyState
            title="No pending actions"
            description="Nothing is waiting on you right now."
            action={
              <Link href="/agreements">
                <Button variant="secondary" size="sm">
                  Back to all agreements
                </Button>
              </Link>
            }
          />
        ) : (
          <ol className="border-y border-rule bg-sheet content-fade-in">
            {pending.map((item, i) => (
              <li key={item.agreementId} className="stagger-item border-b border-rule last:border-b-0" style={staggerStyle(i)}>
                <Link
                  href={`/agreements/${item.agreementId}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-4 hover:bg-vellum/60"
                >
                  <span className="w-7 shrink-0 font-mono text-xs text-ink-3 tabular-nums">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{item.title}</span>
                    <span className="mt-0.5 block font-mono text-2xs text-ink-3">{item.publicId}</span>
                  </span>
                  <span className="text-xs text-attention">
                    {ACTION_LABELS[item.action as PendingActionType] ?? item.action}
                  </span>
                  <StatusStamp status={item.status} />
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  /* -------------------------------- list view ------------------------------ */
  const agreements = listQuery.data?.agreements ?? [];
  const nextCursor = listQuery.data?.nextCursor ?? null;

  const tabClass = (active: boolean) =>
    [
      'inline-flex min-h-11 items-center border-b-2 px-3 text-sm whitespace-nowrap',
      active
        ? 'border-navy font-medium text-ink'
        : 'border-transparent text-ink-2 hover:border-rule-strong hover:text-ink',
    ].join(' ');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Agreements"
        description="Every agreement, its lifecycle, and who holds it."
        actions={
          <Link href="/agreements/new">
            <Button icon={<FilePlus2 className="h-4 w-4" />}>New agreement</Button>
          </Link>
        }
      />

      <div className="flex gap-1 overflow-x-auto border-b border-rule" role="tablist" aria-label="Status">
        <button
          type="button"
          role="tab"
          aria-selected={!status && !pendingView}
          onClick={() => setParam('status', '')}
          className={tabClass(!status && !pendingView)}
        >
          All
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={pendingView}
          onClick={() => {
            const next = new URLSearchParams(params.toString());
            next.set('pending', 'me');
            next.delete('status');
            router.replace(`/agreements?${next.toString()}`, { scroll: false });
          }}
          className={tabClass(pendingView)}
        >
          <span className="mr-1.5 inline-block h-1.5 w-1.5 bg-attention" aria-hidden />
          Awaiting action
        </button>
        {TABS.slice(1).map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={status === tab.value}
            onClick={() => setParam('status', tab.value)}
            className={tabClass(status === tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filter strip */}
      <div className="border-y border-rule bg-sheet px-4 py-3">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="relative md:col-span-2 xl:col-span-1">
            <svg
              viewBox="0 0 16 16"
              className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.4}
              aria-hidden
            >
              <circle cx="7" cy="7" r="4.4" />
              <path d="M10.3 10.3 14 14" />
            </svg>
            <Input
              aria-label="Search agreements"
              placeholder="Search title or Agreement ID…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select aria-label="Category" value={category} onChange={(e) => setParam('category', e.target.value)}>
            {CATEGORY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select aria-label="Role" value={role} onChange={(e) => setParam('role', e.target.value)}>
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <Input
              aria-label="Created from"
              type="date"
              value={dateFrom}
              onChange={(e) => setParam('dateFrom', e.target.value)}
            />
            <Input
              aria-label="Created to"
              type="date"
              value={dateTo}
              onChange={(e) => setParam('dateTo', e.target.value)}
            />
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-rule pt-2">
          <p className="text-caps text-ink-3">
            {hasFilters ? 'Filters applied' : 'All agreements'}
          </p>
          {hasFilters ? (
            <Button variant="ghost" size="sm" icon={<X className="h-4 w-4" />} onClick={clearAll}>
              Clear filters
            </Button>
          ) : null}
        </div>
      </div>

      {listQuery.isPending ? (
        showListPending ? (
          <ListSkeleton />
        ) : (
          <div className="min-h-[16rem]" aria-busy="true" aria-live="polite"><LoadingStatus /></div>
        )
      ) : listQuery.isError ? (
        <ErrorState description="We couldn't load your agreements." onRetry={() => listQuery.refetch()} />
      ) : agreements.length === 0 ? (
        <EmptyState
          title={hasFilters ? 'No agreements match these filters' : 'No agreements yet'}
          description={
            hasFilters
              ? 'Try widening the filters or clearing the search.'
              : 'Create your first agreement from a template to get started in Ghana.'
          }
          action={
            hasFilters ? (
              <Button variant="secondary" size="sm" onClick={clearAll}>
                Clear filters
              </Button>
            ) : (
              <Link href="/agreements/new">
                <Button size="sm">New agreement</Button>
              </Link>
            )
          }
        />
      ) : (
        <div className="content-fade-in">
          <div className="hidden md:block">
            <Table>
              <thead>
                <tr>
                  <Th>Agreement</Th>
                  <Th>Status</Th>
                  <Th>Category</Th>
                  <Th>Your role</Th>
                  <Th>Updated</Th>
                  <Th>Expires</Th>
                </tr>
              </thead>
              <tbody>
                {agreements.map((item, i) => (
                  <Tr
                    key={item.id}
                    onClick={() => router.push(`/agreements/${item.id}`)}
                    className="stagger-item"
                    style={staggerStyle(i)}
                  >
                    <Td>
                      <p className="max-w-md truncate font-medium text-ink">{item.title}</p>
                      <p className="mt-0.5 font-mono text-2xs text-ink-3">{item.publicId}</p>
                    </Td>
                    <Td>
                      <StatusStamp status={item.status} />
                    </Td>
                    <Td className="text-xs text-ink-2">{item.categoryCode}</Td>
                    <Td>{item.myRole ? <RoleBadge role={item.myRole} /> : '—'}</Td>
                    <Td className="text-ink-2">{relativeTime(item.updatedAt)}</Td>
                    <Td className={item.expiresAt ? 'text-ink-2' : 'text-ink-3'}>
                      {formatDate(item.expiresAt)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>

          {/* Mobile: ledger rows, not cards. */}
          <ol className="border-y border-rule bg-sheet md:hidden">
            {agreements.map((item, i) => (
              <li key={item.id} className="stagger-item border-b border-rule last:border-b-0" style={staggerStyle(i)}>
                <Link href={`/agreements/${item.id}`} className="block px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{item.title}</p>
                      <p className="mt-0.5 font-mono text-2xs text-ink-3">{item.publicId}</p>
                    </div>
                    <StatusStamp status={item.status} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                    <span className="text-caps text-ink-3">{item.categoryCode}</span>
                    {item.myRole ? <RoleBadge role={item.myRole} /> : null}
                    <span>Updated {relativeTime(item.updatedAt)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ol>

          {nextCursor ? (
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" loading={loadingMore} loadingLabel="Loading more…" onClick={loadMore}>
                Load more
              </Button>
            </div>
          ) : (
            <p className="mt-4 text-center text-caps text-ink-3">
              {agreements.length} agreement{agreements.length === 1 ? '' : 's'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function AgreementsPage() {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <AgreementsContent />
    </Suspense>
  );
}
