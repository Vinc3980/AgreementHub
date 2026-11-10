'use client';

/** Notifications: full list with unread filter and mark-read actions. */
import Link from 'next/link';
import { useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState, ListSkeleton, LoadingStatus, staggerStyle } from '@/components/ui/states';
import { useNotifications } from '@/lib/queries';
import { useDelayedPending } from '@/lib/use-delayed-pending';
import { post } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { eventLabel, formatDateTime } from '@/lib/format';

export default function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const query = useNotifications(unreadOnly);
  const queryClient = useQueryClient();
  const toast = useToast();
  const showPending = useDelayedPending(query.isPending && !query.data);

  const notifications = query.data?.notifications ?? [];
  const unread = query.data?.counts.unread ?? 0;

  async function markRead(id: string) {
    try {
      await post(`/notifications/${id}/read`);
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    } catch {
      toast.error('Could not mark the notification as read.');
    }
  }

  async function markAllRead() {
    try {
      await post('/notifications/read-all');
      toast.success('All notifications marked as read.');
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    } catch {
      toast.error('Could not mark all as read.');
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="Notifications"
        description={
          unread > 0 ? `${unread} unread notification${unread === 1 ? '' : 's'}.` : 'You’re all caught up.'
        }
        actions={
          unread > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<CheckCheck className="h-4 w-4" />}
              onClick={markAllRead}
            >
              Mark all read
            </Button>
          ) : null
        }
      />

      <div className="flex gap-1 border-b border-rule" role="tablist" aria-label="Notification filter">
        {[
          { value: false, label: 'All' },
          { value: true, label: 'Unread' },
        ].map((opt) => (
          <button
            key={String(opt.value)}
            type="button"
            role="tab"
            aria-selected={unreadOnly === opt.value}
            onClick={() => setUnreadOnly(opt.value)}
            className={[
              'border-b-2 px-3.5 py-2.5 text-sm font-medium',
              unreadOnly === opt.value
                ? 'border-navy text-navy'
                : 'border-transparent text-ink-2 hover:text-ink',
            ].join(' ')}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {query.isPending ? (
        showPending ? (
          <ListSkeleton />
        ) : (
          <div className="min-h-[12rem]" aria-busy="true" aria-live="polite"><LoadingStatus /></div>
        )
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : notifications.length === 0 ? (
        <EmptyState
          icon={<Bell className="h-6 w-6" />}
          title={unreadOnly ? 'No unread notifications' : 'No notifications yet'}
          description="Invitations, approvals, signatures, and status changes will show up here."
        />
      ) : (
        <ul className="divide-y divide-rule rounded-none border border-rule bg-sheet content-fade-in">
          {notifications.map((n, i) => (
            <li
              key={n.id}
              className={`stagger-item flex flex-wrap items-start gap-3 px-5 py-4 ${n.readAt ? '' : 'bg-navy-tint/30'}`}
              style={staggerStyle(i)}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-ink">{eventLabel(n.type)}</p>
                  {!n.readAt ? <Badge tone="brand">New</Badge> : null}
                </div>
                <p className="mt-1 text-sm text-ink-2">
                  {n.payload?.title ? String(n.payload.title) : null}
                  {n.payload?.from && n.payload?.to ? (
                    <span>
                      {' '}
                      · {String(n.payload.from)} → {String(n.payload.to)}
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-ink-3">{formatDateTime(n.createdAt)}</p>
              </div>
              <div className="flex items-center gap-2">
                {n.agreementId ? (
                  <Link href={`/agreements/${n.agreementId}`}>
                    <Button variant="secondary" size="sm">
                      Open
                    </Button>
                  </Link>
                ) : null}
                {!n.readAt ? (
                  <Button variant="ghost" size="sm" onClick={() => markRead(n.id)}>
                    Mark read
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-ink-3">
        In-app notifications are delivered in real time. Email delivery is a later-stage item.
        Nothing here has ever been emailed in this build.
      </p>
    </div>
  );
}
