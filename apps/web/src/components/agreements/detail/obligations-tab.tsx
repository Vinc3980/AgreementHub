'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, Plus, RotateCcw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState, CardSkeleton } from '@/components/ui/states';
import { useObligations } from '@/lib/queries';
import { post } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { formatDate, formatDateTime, obligationStatusLabel, obligationStatusTone } from '@/lib/format';
import type { AgreementDetailResponse, Obligation } from '@/lib/types';

function toLocalDateInputValue(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ObligationsTab({
  agreementId,
  parties,
  canManage,
}: {
  agreementId: string;
  parties: AgreementDetailResponse['parties'];
  canManage: boolean;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isPending, isError, refetch } = useObligations(agreementId);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [responsiblePartyId, setResponsiblePartyId] = useState('');
  const [responsibleLabel, setResponsibleLabel] = useState('');
  const [notes, setNotes] = useState('');

  const obligations = data?.obligations ?? [];
  const counts = useMemo(() => {
    const c = { active: 0, overdue: 0, completed: 0 };
    for (const o of obligations) {
      if (o.status === 'COMPLETED') c.completed++;
      else if (o.status !== 'CANCELLED') c.active++;
      if (o.status === 'OVERDUE') c.overdue++;
    }
    return c;
  }, [obligations]);

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ['agreement', agreementId, 'obligations'] });
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !dueDate) return;
    setSaving(true);
    try {
      const dueAt = new Date(`${dueDate}T12:00:00.000Z`).toISOString();
      await post(`/agreements/${agreementId}/obligations`, {
        title: title.trim(),
        description: description.trim() || null,
        dueAt,
        responsiblePartyId: responsiblePartyId || null,
        responsibleLabel: responsibleLabel.trim() || null,
        notes: notes.trim() || null,
      });
      toast.success('Obligation added.');
      setOpen(false);
      setTitle(''); setDescription(''); setDueDate(''); setResponsiblePartyId(''); setResponsibleLabel(''); setNotes('');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add obligation.');
    } finally {
      setSaving(false);
    }
  }

  async function act(id: string, action: 'complete' | 'cancel' | 'reopen') {
    try {
      await post(`/obligations/${id}/${action}`, {});
      toast.success(action === 'complete' ? 'Obligation marked completed.' : action === 'cancel' ? 'Obligation cancelled.' : 'Obligation reopened.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed.');
    }
  }

  if (isPending) return <CardSkeleton rows={4} />;
  if (isError) return <ErrorState onRetry={() => refetch()} />;

  return (
    <div className="space-y-5 content-fade-in">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule pb-4">
        <div>
          <h3 className="text-base font-semibold text-ink">Obligations</h3>
          <p className="mt-1 text-sm text-ink-2">
            Track important responsibilities after signing. {counts.active} active, {counts.overdue} overdue, {counts.completed} completed.
            Obligations are never marked completed automatically when a due date passes.
          </p>
        </div>
        {canManage ? (
          <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Add obligation</Button>
        ) : null}
      </div>

      {obligations.length === 0 ? (
        <EmptyState
          title="No obligations yet"
          description={canManage ? 'Add payment deadlines, delivery milestones, renewals, notice periods, or other agreed responsibilities.' : 'No obligations have been recorded for this agreement.'}
        />
      ) : (
        <ul className="space-y-3">
          {obligations.map((o: Obligation) => (
            <li key={o.id} className="border border-rule bg-sheet p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink">{o.title}</p>
                    <Badge tone={obligationStatusTone(o.status)}>{obligationStatusLabel(o.status)}</Badge>
                  </div>
                  {o.description ? <p className="mt-1 text-sm text-ink-2">{o.description}</p> : null}
                  <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
                    <div className="flex items-center gap-1"><CalendarClock className="h-3.5 w-3.5" /> Due {formatDate(o.dueAt)}</div>
                    <div>Responsible: {o.responsibleName || o.responsibleLabel || '—'}</div>
                    {o.versionId ? <div>Governs this obligation (version linked)</div> : <div>Not linked to a specific version</div>}
                    {o.completedAt ? <div>Completed {formatDateTime(o.completedAt)}</div> : null}
                    {o.cancelledAt ? <div>Cancelled {formatDateTime(o.cancelledAt)}</div> : null}
                  </dl>
                  {o.notes ? <p className="mt-2 border-l-2 border-rule pl-2 text-xs text-ink-2">{o.notes}</p> : null}
                </div>
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    {o.status !== 'COMPLETED' && o.status !== 'CANCELLED' ? (
                      <>
                        <Button size="sm" variant="secondary" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => act(o.id, 'complete')}>Complete</Button>
                        <Button size="sm" variant="secondary" icon={<XCircle className="h-4 w-4" />} onClick={() => act(o.id, 'cancel')}>Cancel</Button>
                      </>
                    ) : (
                      <Button size="sm" variant="secondary" icon={<RotateCcw className="h-4 w-4" />} onClick={() => act(o.id, 'reopen')}>Reopen</Button>
                    )}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Add obligation" description="Record a payment deadline, delivery milestone, renewal, notice period, or other responsibility." footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={create} loading={saving} disabled={!title.trim() || !dueDate}>Add obligation</Button></>}>
        <form onSubmit={create} className="space-y-4" noValidate>
          <Input label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Deliver final report" />
          <Textarea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What needs to happen?" />
          <Input label="Due date" type="date" required value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <Select label="Responsible party" value={responsiblePartyId} onChange={(e) => setResponsiblePartyId(e.target.value)}>
            <option value="">Select a party (optional)</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.display_name || p.email} ({p.role})</option>)}
          </Select>
          <Input label="Responsible party (other)" value={responsibleLabel} onChange={(e) => setResponsibleLabel(e.target.value)} placeholder="Use if not listed above" />
          <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </form>
      </Modal>
    </div>
  );
}
