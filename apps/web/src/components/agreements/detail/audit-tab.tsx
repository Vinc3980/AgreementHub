'use client';

/**
 * Audit tab: the append-only hash chain, read as a ledger.
 * Events are classified and filterable; metadata stays collapsed.
 */
import { useState } from 'react';
import { Download, ShieldCheck, ShieldX } from 'lucide-react';
import { EmptyState, ErrorState, CardSkeleton, LoadingStatus, staggerStyle } from '@/components/ui/states';
import { Sheet } from '@/components/ui/sheet';
import { useAudit } from '@/lib/queries';
import { useDelayedPending } from '@/lib/use-delayed-pending';
import {
  auditCategoryLabel,
  eventLabel,
  formatDateTime,
  shortHash,
} from '@/lib/format';

type CategoryFilter = 'ALL' | 'USER' | 'AGREEMENT' | 'SYSTEM';

export function AuditTab({ agreementId, publicId }: { agreementId: string; publicId: string }) {
  const auditQuery = useAudit(agreementId);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [filter, setFilter] = useState<CategoryFilter>('ALL');
  const showPending = useDelayedPending(auditQuery.isPending && !auditQuery.data);

  if (auditQuery.isPending) {
    if (!showPending) return <div className="min-h-[16rem]" aria-busy="true" aria-live="polite"><LoadingStatus /></div>;
    return <CardSkeleton rows={6} />;
  }
  if (auditQuery.isError) return <ErrorState onRetry={() => auditQuery.refetch()} />;

  const events = auditQuery.data?.events ?? [];
  const counts: Record<CategoryFilter, number> = {
    ALL: events.length,
    USER: events.filter((e) => e.category === 'USER').length,
    AGREEMENT: events.filter((e) => e.category === 'AGREEMENT').length,
    SYSTEM: events.filter((e) => e.category === 'SYSTEM').length,
  };
  const visible = filter === 'ALL' ? events : events.filter((e) => e.category === filter);

  const chainState = auditQuery.data?.chainVerified;

  return (
    <div className="space-y-5 content-fade-in">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule pb-4">
        <div className="flex items-start gap-2.5 text-sm">
          {chainState === false ? (
            <ShieldX className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
          ) : (
            <ShieldCheck className={`mt-0.5 h-4 w-4 shrink-0 ${chainState ? 'text-seal' : 'text-ink-3'}`} aria-hidden />
          )}
          <div>
            <p className="text-ink">
              Every action is appended to a per-agreement hash chain.
              {chainState === true ? (
                <span className="text-seal"> Chain integrity verified.</span>
              ) : chainState === false ? (
                <span className="font-medium text-danger"> Chain integrity check failed.</span>
              ) : null}
            </p>
            <p className="mt-0.5 text-xs text-ink-2">
              Append-only: neither the interface nor any API can modify or delete an event.
            </p>
          </div>
        </div>
        <a
          href={`/api/v1/agreements/${agreementId}/audit/export`}
          className="inline-flex min-h-9 items-center gap-1.5 border border-rule-strong bg-sheet px-3 text-xs font-medium text-ink hover:border-ink hover:bg-vellum"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          Export CSV
        </a>
      </div>

      {/* Classification filters */}
      <div className="flex flex-wrap items-center gap-4" role="group" aria-label="Filter audit events by class">
        {(['ALL', 'USER', 'AGREEMENT', 'SYSTEM'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
            className={`inline-flex min-h-9 items-center gap-1.5 border-b-2 px-0.5 text-sm ${
              filter === key
                ? 'border-navy font-medium text-ink'
                : 'border-transparent text-ink-2 hover:border-rule-strong hover:text-ink'
            }`}
          >
            {key === 'ALL' ? 'All events' : auditCategoryLabel(key)}
            <span className="font-mono text-2xs text-ink-3 tabular-nums">[{counts[key]}]</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={events.length === 0 ? 'No audit events' : `No ${auditCategoryLabel(filter).toLowerCase()} events`}
          description={
            events.length === 0
              ? 'Events appear as soon as the agreement changes state.'
              : 'Choose another class to see more of the trail.'
          }
        />
      ) : (
        <Sheet label="Audit trail">
          <ol>
            {visible.map((event, index) => {
              const isOpen = expanded === event.seq;
              const hasMeta = event.metadata && Object.keys(event.metadata).length > 0;
              return (
                <li
                  key={event.seq ?? event.eventHash}
                  className={`stagger-item ${index === visible.length - 1 ? '' : 'border-b border-rule'}`.trim()}
                  style={staggerStyle(index)}
                >
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : event.seq)}
                    className="flex w-full flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-vellum/60 sm:px-5"
                    aria-expanded={isOpen}
                  >
                    <span className="flex shrink-0 items-baseline gap-2 sm:w-28">
                      <span className="font-mono text-xs text-ink-3 tabular-nums">
                        {event.seq != null ? String(event.seq).padStart(4, '0') : '—'}
                      </span>
                      <span className="font-mono text-2xs text-ink-3">
                        {event.occurredAt.slice(11, 19)}
                      </span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-2">
                        <span className="text-sm text-ink">{eventLabel(event.eventType)}</span>
                        <span className="text-caps text-ink-3">
                          {auditCategoryLabel(event.category)}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-2">
                        {event.actorLabel}
                        <span className="text-ink-3"> · {formatDateTime(event.occurredAt)}</span>
                      </span>
                      <span className="mt-0.5 block font-mono text-2xs text-ink-3">
                        hash {shortHash(event.eventHash)}
                      </span>
                    </span>
                    {hasMeta ? (
                      <span className="mt-0.5 text-caps text-navy">{isOpen ? 'Hide' : 'Detail'}</span>
                    ) : (
                      <span className="w-8" />
                    )}
                  </button>

                  {isOpen ? (
                    <div className="border-t border-rule bg-paper/60 px-4 py-3 sm:px-5">
                      {hasMeta ? (
                        <pre className="overflow-x-auto font-mono text-2xs leading-relaxed text-ink-2">
                          {JSON.stringify(event.metadata, null, 2)}
                        </pre>
                      ) : (
                        <p className="text-xs text-ink-2">No metadata for this event.</p>
                      )}
                      <p className="mt-2 border-t border-rule pt-2 font-mono text-2xs break-all text-ink-3">
                        event_hash: {event.eventHash}
                        {event.requestId ? ` · request: ${event.requestId}` : ''}
                      </p>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </Sheet>
      )}

      <p className="text-xs text-ink-3">
        Audit trail for <span className="font-mono text-ink-2">{publicId}</span>. The CSV export
        includes each event&apos;s class.
      </p>
    </div>
  );
}
