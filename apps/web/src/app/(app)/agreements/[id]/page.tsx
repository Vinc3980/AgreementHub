'use client';

/**
 * Agreement detail: the instrument itself.
 * Masthead of identity + lifecycle, then the document, parties, negotiation,
 * versions, audit, and assistant tabs. Actions stay where they were.
 */
import Link from 'next/link';
import { use, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  FilePenLine,
  GitBranch,
  MoreHorizontal,
  PenLine,
  Scale,
  Send,
  ShieldCheck,
  Signature,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dropdown, MenuItem } from '@/components/ui/dropdown';
import { Tabs } from '@/components/ui/tabs';
import { ErrorState, ListSkeleton } from '@/components/ui/states';
import { StatusStamp } from '@/components/ui/status-stamp';
import { LifecycleTrack } from '@/components/ui/lifecycle-track';
import { NextStepLine } from '@/components/ui/next-step-line';
import { HashText } from '@/components/ui/hash-text';
import { Rosette } from '@/components/ui/rosette';
import { Marginalia } from '@/components/ui/marginalia';
import { SealCeremony } from '@/components/ui/seal-ceremony';
import { AssistantPanel } from '@/components/ai/assistant-panel';
import { DocumentTab } from '@/components/agreements/detail/document-tab';
import { PartiesTab } from '@/components/agreements/detail/parties-tab';
import { NegotiationTab } from '@/components/agreements/detail/negotiation-tab';
import { VersionsTab } from '@/components/agreements/detail/versions-tab';
import { ObligationsTab } from '@/components/agreements/detail/obligations-tab';
import { AuditTab } from '@/components/agreements/detail/audit-tab';
import {
  AmendmentDialog,
  ApprovalDialog,
  CreateVersionDialog,
  ReasonDialog,
  ShareDialog,
  SignDialog,
} from '@/components/agreements/detail/dialogs';
import { canEdit, canManage, manualTransitions, TRANSITION_DANGER, TRANSITION_LABELS } from '@/lib/action-rules';
import { findMissingRequired, parseTemplateDefinition } from '@agreementhub/domain/template';
import { useAgreement, useDashboard, useSignatureStatus, useTemplateDefinition } from '@/lib/queries';
import { useDelayedPending } from '@/lib/use-delayed-pending';
import { useSession } from '@/lib/session';
import { useToast } from '@/lib/toast';
import { post } from '@/lib/api';
import { formatDate, ACTION_DESCRIPTIONS, ACTION_LABELS } from '@/lib/format';
import type { FinalizeResult, PendingActionType, TemplateValues } from '@/lib/types';

type TabValue = 'document' | 'parties' | 'negotiation' | 'versions' | 'obligations' | 'audit' | 'assistant';

export default function AgreementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user, organizations } = useSession();

  const detailQuery = useAgreement(id);
  const dashboardQuery = useDashboard();
  const signatureStatusQuery = useSignatureStatus(id);
  const templateQuery = useTemplateDefinition(detailQuery.data?.agreement.templateId ?? undefined);
  const showDetailPending = useDelayedPending(detailQuery.isPending && !detailQuery.data);

  const [tab, setTab] = useState<TabValue>('document');
  const [shareOpen, setShareOpen] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [sealOpen, setSealOpen] = useState(false);
  const [approval, setApproval] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [versionOpen, setVersionOpen] = useState(false);
  const [amendmentOpen, setAmendmentOpen] = useState(false);
  const [reasonAction, setReasonAction] = useState<{
    to: string;
    title: string;
    description: string;
    confirmLabel: string;
  } | null>(null);

  const detail = detailQuery.data;

  const ctx = useMemo(() => {
    if (!detail || !user) return { orgRole: null, partyRole: null };
    const orgRole =
      organizations.find((o) => o.id === detail.agreement.orgId)?.role ?? null;
    const partyRole =
      detail.parties.find((p) => p.email.toLowerCase() === user.email.toLowerCase())?.role ?? null;
    return { orgRole, partyRole };
  }, [detail, user, organizations]);

  const myPendingAction = useMemo(() => {
    const item = dashboardQuery.data?.pendingActions.find((a) => a.agreementId === id);
    return (item?.action as PendingActionType | undefined) ?? null;
  }, [dashboardQuery.data, id]);

  const templateDefinition = useMemo(
    () =>
      templateQuery.data
        ? parseTemplateDefinition(templateQuery.data.template.content_schema)
        : null,
    [templateQuery.data],
  );

  const missingRequiredFields = useMemo(() => {
    if (!detail || !templateDefinition) return [];
    const values: TemplateValues = {};
    for (const f of detail.fields) {
      values[f.code] = f.value === null || f.value === undefined ? null : (f.value as TemplateValues[string]);
    }
    return findMissingRequired(templateDefinition, values);
  }, [detail, templateDefinition]);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['agreement', id] });
    void queryClient.invalidateQueries({ queryKey: ['agreement', id, 'versions'] });
    void queryClient.invalidateQueries({ queryKey: ['agreement', id, 'audit'] });
    void queryClient.invalidateQueries({ queryKey: ['agreement', id, 'signature-status'] });
    void queryClient.invalidateQueries({ queryKey: ['agreement', id, 'comments'] });
    void queryClient.invalidateQueries({ queryKey: ['agreement', id, 'proposals'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['agreements'] });
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }

  const transitionMutation = useMutation({
    mutationFn: ({ to, reason }: { to: string; reason?: string }) =>
      post(`/agreements/${id}/status`, { to, reason }),
    onSuccess: (_data, vars) => {
      toast.success(`Status updated: ${TRANSITION_LABELS[vars.to] ?? vars.to}.`);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Status change failed.'),
  });

  const requestApprovalMutation = useMutation({
    mutationFn: () => post(`/approvals/request`, { agreementId: id }),
    onSuccess: () => {
      toast.success('Approval requested from the designated approvers.');
      invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const requestSignatureMutation = useMutation({
    mutationFn: () => post(`/signatures/request`, { agreementId: id }),
    onSuccess: () => {
      toast.success('Signature request sent to the required signers.');
      invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const finalizeMutation = useMutation({
    mutationFn: () => post<FinalizeResult>(`/agreements/${id}/finalize`),
    onSuccess: (res) => {
      setSealOpen(false);
      toast.success(`Agreement ${res.publicId} finalized and sealed. Verification is live.`);
      invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  if (detailQuery.isPending) {
    if (!showDetailPending) {
      return <div className="min-h-[24rem]" aria-busy="true" aria-live="polite" />;
    }
    return (
      <div className="space-y-4">
        <ListSkeleton rows={3} />
      </div>
    );
  }

  if (detailQuery.isError || !detail) {
    return (
      <ErrorState
        title="Agreement not available"
        description={
          detailQuery.error instanceof Error
            ? detailQuery.error.message
            : 'It may not exist, or you may not have access.'
        }
        onRetry={() => detailQuery.refetch()}
      />
    );
  }

  const { agreement, category, templateName, parties, currentVersion } = detail;
  const editable = canEdit(agreement.status, ctx);
  const manageable = canManage(ctx);
  const transitions = manualTransitions(agreement.status, ctx);
  const sigStatus = signatureStatusQuery.data;
  const allSigned = sigStatus ? sigStatus.signed >= sigStatus.required && sigStatus.required > 0 : false;
  const isTerminal = ['EXPIRED', 'CANCELLED', 'TERMINATED', 'REJECTED'].includes(agreement.status);
  const downloadBase = `/api/v1/agreements/${agreement.id}/documents/${currentVersion?.versionNumber ?? 1}/download`;
  const pdfBase = `/api/v1/agreements/${agreement.id}/documents/${currentVersion?.versionNumber ?? 1}/pdf`;

  return (
    <div className="flex flex-col gap-7 content-fade-in">
      {/* Identity block */}
      <div className="flex flex-col gap-5">
        <Link
          href="/agreements"
          className="inline-flex w-fit items-center gap-1.5 text-xs text-ink-2 hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          All agreements
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex min-w-0 items-start gap-4">
            <Rosette
              hash={currentVersion?.documentHash ?? agreement.publicId}
              size={64}
              className={`mt-1 shrink-0 ${currentVersion?.status === 'FINAL' ? 'text-seal' : 'text-ink-3'}`}
              decorative
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-caps text-ink-3">Agreement</span>
                <StatusStamp status={agreement.status} />
                {currentVersion?.status === 'FINAL' ? (
                  <span className="inline-flex items-center gap-1 border border-seal-rule bg-seal-tint px-2 py-0.5 text-xs font-medium text-seal">
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                    Sealed
                  </span>
                ) : null}
              </div>
              <h1 className="mt-1 max-w-3xl font-serif text-xl leading-tight text-ink sm:text-2xl">
                {agreement.title}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                <HashText value={agreement.publicId} label="ID" copyable={false} />
                {currentVersion ? <HashText value={currentVersion.documentHash} label="Hash" blocks={2} /> : null}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {editable ? (
              <Link href={`/agreements/${agreement.id}/edit`}>
                <Button variant="secondary" icon={<FilePenLine className="h-4 w-4" />}>
                  Edit draft
                </Button>
              </Link>
            ) : null}

            {agreement.status === 'DRAFT' && manageable ? (
              <Button
                variant="secondary"
                icon={<Send className="h-4 w-4" />}
                loading={transitionMutation.isPending}
                loadingLabel="Submitting…"
                onClick={() => transitionMutation.mutate({ to: 'REVIEW' })}
              >
                Submit for review
              </Button>
            ) : null}

            {editable && currentVersion && currentVersion.status !== 'FINAL' ? (
              <Button
                variant="secondary"
                icon={<GitBranch className="h-4 w-4" />}
                onClick={() => setVersionOpen(true)}
              >
                New version
              </Button>
            ) : null}

            {agreement.status === 'ACTIVE' && agreement.finalVersionId && manageable ? (
              <Button
                variant="secondary"
                icon={<PenLine className="h-4 w-4" />}
                onClick={() => setAmendmentOpen(true)}
              >
                Start amendment
              </Button>
            ) : null}

            <Dropdown
              trigger={({ toggle, open }) => (
                <Button
                  variant="secondary"
                  onClick={toggle}
                  aria-expanded={open}
                  aria-haspopup="menu"
                  icon={<MoreHorizontal className="h-4 w-4" />}
                >
                  More
                </Button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    onClick={() => {
                      close();
                      setShareOpen(true);
                    }}
                  >
                    <Users className="h-4 w-4" aria-hidden />
                    Share &amp; verify
                  </MenuItem>

                  {currentVersion ? (
                    <>
                      <MenuItem href={downloadBase} onClick={close}>
                        <Download className="h-4 w-4" aria-hidden />
                        Download document (HTML)
                      </MenuItem>
                      <MenuItem href={pdfBase} onClick={close}>
                        <Download className="h-4 w-4" aria-hidden />
                        Download PDF
                      </MenuItem>
                    </>
                  ) : null}
                  <MenuItem
                    href={`/api/v1/agreements/${agreement.id}/audit/export`}
                    onClick={close}
                  >
                    <Download className="h-4 w-4" aria-hidden />
                    Export audit trail (CSV)
                  </MenuItem>

                  <MenuItem
                    onClick={() => {
                      close();
                      window.open(`/verify/${agreement.publicId}`, '_blank', 'noopener');
                    }}
                  >
                    <ShieldCheck className="h-4 w-4" aria-hidden />
                    Public verification page
                  </MenuItem>

                  {manageable && (agreement.status === 'REVIEW' || agreement.status === 'NEGOTIATION') ? (
                    <MenuItem
                      onClick={() => {
                        close();
                        requestApprovalMutation.mutate();
                      }}
                    >
                      <Scale className="h-4 w-4" aria-hidden />
                      Request approvals
                    </MenuItem>
                  ) : null}

                  {manageable && agreement.status === 'AWAITING_SIGNATURES' ? (
                    <MenuItem
                      onClick={() => {
                        close();
                        requestSignatureMutation.mutate();
                      }}
                    >
                      <Signature className="h-4 w-4" aria-hidden />
                      Request signatures
                    </MenuItem>
                  ) : null}

                  {transitions.map((rule) => (
                    <MenuItem
                      key={rule.to}
                      danger={TRANSITION_DANGER.has(rule.to)}
                      onClick={() => {
                        close();
                        if (rule.reasonRequired) {
                          setReasonAction({
                            to: rule.to,
                            title: TRANSITION_LABELS[rule.to] ?? rule.to,
                            description: `${rule.trigger}. A reason is required and will be recorded in the audit trail.`,
                            confirmLabel: TRANSITION_LABELS[rule.to] ?? rule.to,
                          });
                        } else {
                          transitionMutation.mutate({ to: rule.to });
                        }
                      }}
                    >
                      {TRANSITION_LABELS[rule.to] ?? rule.to}
                    </MenuItem>
                  ))}
                </>
              )}
            </Dropdown>
          </div>
        </div>

        {/* Lifecycle + next step */}
        <div className="grid gap-5 border-y border-rule bg-sheet px-5 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="min-w-0">
            <LifecycleTrack
              status={agreement.status}
              reason={agreement.closedReason ?? undefined}
            />
          </div>
          <div className="lg:border-l lg:border-rule lg:pl-5">
            <NextStepLine
              status={agreement.status}
              pendingAction={myPendingAction}
              parties={parties.map((p) => ({
                email: p.email,
                display_name: p.display_name,
                role: p.role,
                signed_at: p.signed_at,
              }))}
              expiresAt={agreement.expiresAt}
              updatedAt={agreement.updatedAt}
              signature={sigStatus ?? null}
            />
          </div>
        </div>

        {/* Specification strip: ruled facts, not a card. */}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-b border-rule pb-5 text-sm sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Category', category?.label ?? '—'],
            ['Template', templateName ?? '—'],
            ['Version', currentVersion ? `v${currentVersion.versionNumber}` : '—'],
            ['Created', formatDate(agreement.createdAt)],
            ['Expires', formatDate(agreement.expiresAt)],
            ['Closed', agreement.closedReason ?? '—'],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-caps text-ink-3">{label}</dt>
              <dd
                className={`mt-1 truncate ${label === 'Closed' && value !== '—' ? 'text-danger' : 'text-ink'}`}
                title={String(value)}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>

        {/* Missing required fields */}
        {missingRequiredFields.length > 0 &&
        (agreement.status === 'DRAFT' || agreement.status === 'NEGOTIATION') ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-attention bg-attention-tint px-4 py-3.5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-attention" aria-hidden />
              <div>
                <p className="text-sm font-medium text-ink">
                  {missingRequiredFields.length} required field
                  {missingRequiredFields.length === 1 ? '' : 's'} still need
                  {missingRequiredFields.length === 1 ? 's' : ''} a value
                </p>
                <p className="mt-0.5 text-sm text-ink-2">
                  {missingRequiredFields.map((m) => m.label).join(', ')}. Complete these before
                  requesting approvals or signatures.
                </p>
              </div>
            </div>
            {canEdit(agreement.status, ctx) ? (
              <Link href={`/agreements/${id}/edit`}>
                <Button icon={<FilePenLine className="h-4 w-4" />}>Fill required fields</Button>
              </Link>
            ) : null}
          </div>
        ) : null}

        {/* Required action */}
        {myPendingAction ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-navy bg-navy-tint px-4 py-3.5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-navy" aria-hidden />
              <div>
                <p className="text-sm font-medium text-ink">
                  {ACTION_LABELS[myPendingAction]}. Your action is required
                </p>
                <p className="mt-0.5 text-sm text-ink-2">
                  {ACTION_DESCRIPTIONS[myPendingAction]}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {myPendingAction === 'SIGN' ? (
                <Button icon={<Signature className="h-4 w-4" />} onClick={() => setSignOpen(true)}>
                  Review &amp; sign
                </Button>
              ) : null}
              {myPendingAction === 'APPROVE' ? (
                <>
                  <Button variant="danger" onClick={() => setApproval('REJECTED')}>
                    Reject
                  </Button>
                  <Button icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setApproval('APPROVED')}>
                    Approve
                  </Button>
                </>
              ) : null}
              {myPendingAction === 'REVIEW' ? (
                <Button
                  onClick={() => requestApprovalMutation.mutate()}
                  loading={requestApprovalMutation.isPending}
                  loadingLabel="Requesting…"
                >
                  Request approvals
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Signature progress + seal */}
        {agreement.status === 'AWAITING_SIGNATURES' && sigStatus ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-y border-rule bg-sheet px-4 py-3.5">
            <div className="flex items-center gap-3 text-sm">
              <Signature className="h-4 w-4 shrink-0 text-ink-2" aria-hidden />
              <p className="text-ink">
                <b className="font-mono tabular-nums">
                  {sigStatus.signed} of {sigStatus.required}
                </b>{' '}
                required signatures collected.
              </p>
            </div>
            {allSigned && manageable ? (
              <Button
                icon={<ShieldCheck className="h-4 w-4" />}
                onClick={() => setSealOpen(true)}
              >
                Finalize &amp; seal
              </Button>
            ) : (
              <span className="text-xs text-ink-3">
                Finalization unlocks when every required signer has signed.
              </span>
            )}
          </div>
        ) : null}

        {isTerminal ? (
          <div className="flex items-center gap-3 border-l-2 border-rule-strong px-4 py-3 text-sm text-ink-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
            This agreement is {agreement.status.toLowerCase()} and no longer accepts edits or
            signatures. The audit trail and verification remain available.
          </div>
        ) : null}
      </div>

      {/* Tabs */}
      <div>
        <Tabs<TabValue>
          ariaLabel="Agreement sections"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'document', label: 'Document' },
            { value: 'parties', label: 'Parties', count: parties.length },
            { value: 'negotiation', label: 'Negotiation' },
            { value: 'versions', label: 'Version history' },
            { value: 'obligations', label: 'Obligations' },
            { value: 'audit', label: 'Audit trail' },
            { value: 'assistant', label: 'Assistant' },
          ]}
        />

        <div className="mt-6">
          {tab === 'document' ? <DocumentTab detail={detail} /> : null}
          {tab === 'parties' ? (
            <PartiesTab agreementId={agreement.id} parties={parties} canInvite={manageable} />
          ) : null}
          {tab === 'negotiation' ? (
            <NegotiationTab
              detail={detail}
              editable={editable}
              manageable={manageable}
              templateDefinition={templateDefinition}
            />
          ) : null}
          {tab === 'versions' ? <VersionsTab agreementId={agreement.id} /> : null}
          {tab === 'obligations' ? <ObligationsTab agreementId={agreement.id} parties={parties} canManage={manageable} /> : null}
          {tab === 'audit' ? <AuditTab agreementId={agreement.id} publicId={agreement.publicId} /> : null}
          {tab === 'assistant' ? (
            <AssistantPanel
              mode="view"
              agreementId={agreement.id}
              sections={detail.sections.map((s) => ({ code: s.code, title: s.title }))}
            />
          ) : null}
        </div>
      </div>

      {/* Dialogs */}
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} publicId={agreement.publicId} />
      <SignDialog
        open={signOpen}
        onClose={() => setSignOpen(false)}
        agreementId={agreement.id}
        title={agreement.title}
        publicId={agreement.publicId}
        onDone={invalidate}
      />
      <SealCeremony
        open={sealOpen}
        onClose={() => setSealOpen(false)}
        publicId={agreement.publicId}
        versionNumber={currentVersion?.versionNumber ?? 1}
        documentHash={currentVersion?.documentHash}
        signerSummary={
          sigStatus ? `${sigStatus.signed} of ${sigStatus.required} signatures verified` : undefined
        }
        busy={finalizeMutation.isPending}
        onSeal={() => {
          void finalizeMutation.mutateAsync().catch(() => undefined);
        }}
      />
      <ApprovalDialog
        open={approval !== null}
        onClose={() => setApproval(null)}
        agreementId={agreement.id}
        decision={approval ?? 'APPROVED'}
        onDone={invalidate}
      />
      <CreateVersionDialog
        open={versionOpen}
        onClose={() => setVersionOpen(false)}
        agreementId={agreement.id}
        currentVersionNumber={currentVersion?.versionNumber ?? 0}
        onDone={invalidate}
      />
      <AmendmentDialog
        open={amendmentOpen}
        onClose={() => setAmendmentOpen(false)}
        agreementId={agreement.id}
        finalVersionNumber={currentVersion?.versionNumber ?? 0}
        onDone={invalidate}
      />
      <ReasonDialog
        open={reasonAction !== null}
        onClose={() => setReasonAction(null)}
        title={reasonAction?.title ?? ''}
        description={reasonAction?.description ?? ''}
        confirmLabel={reasonAction?.confirmLabel ?? 'Confirm'}
        onConfirm={async (reason) => {
          if (!reasonAction) return;
          await transitionMutation.mutateAsync({ to: reasonAction.to, reason });
        }}
      />
    </div>
  );
}
