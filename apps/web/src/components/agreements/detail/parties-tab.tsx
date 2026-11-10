'use client';

/** Parties tab: roster, one-time invite links, invitation acceptance. */
import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Link2, Mail, MailPlus, MessageCircle, Share2, Signature, TicketCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { RoleBadge } from '@/components/agreements/status-badge';
import { Avatar } from '@/components/ui/avatar';
import { ApiError, post } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { useSignatures } from '@/lib/queries';
import { formatDateTime, shortHash, signingMethodLabel } from '@/lib/format';
import { PARTY_ROLES, type AgreementDetailResponse, type PartyDetail } from '@/lib/types';

const PARTY_STATUS_TONES: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  INVITED: 'neutral',
  LINKED: 'info',
  VIEWED: 'info',
  APPROVED: 'success',
  DECLINED: 'danger',
};

function partyStatus(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

export function PartiesTab({
  agreementId,
  parties,
  canInvite,
}: {
  agreementId: string;
  parties: AgreementDetailResponse['parties'];
  canInvite: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const signaturesQuery = useSignatures(agreementId);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteExpiresAt, setInviteExpiresAt] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('SIGNER');
  const [inviteOrder, setInviteOrder] = useState('0');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);

  const [acceptToken, setAcceptToken] = useState('');
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [acceptLoading, setAcceptLoading] = useState(false);

  useEffect(() => {
    if (!inviteOpen) {
      setInviteToken(null);
      setInviteExpiresAt(null);
      setInviteEmail('');
      setInviteError(null);
    }
  }, [inviteOpen]);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['agreement', agreementId] });
  }

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setInviteLoading(true);
    setInviteError(null);
    try {
      const res = await post<{ invitation: { token: string; expiresAt?: string } }>(
        `/agreements/${agreementId}/parties`,
        {
          email: inviteEmail.trim(),
          role: inviteRole,
          signingOrder: Number(inviteOrder) || 0,
        },
      );
      setInviteToken(res.invitation.token);
      setInviteExpiresAt(res.invitation.expiresAt ?? null);
      refresh();
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : 'Invite failed.');
    } finally {
      setInviteLoading(false);
    }
  }

  async function onAccept(e: FormEvent) {
    e.preventDefault();
    setAcceptLoading(true);
    setAcceptError(null);
    try {
      await post('/parties/accept-invitation', { token: acceptToken.trim() });
      toast.success('Invitation accepted. You are now a party to this agreement.');
      setAcceptToken('');
      refresh();
    } catch (err) {
      setAcceptError(err instanceof ApiError ? err.message : 'Could not accept the invitation.');
    } finally {
      setAcceptLoading(false);
    }
  }

  function inviteAcceptUrl() {
    if (!inviteToken || typeof window === 'undefined') return '';
    return `${window.location.origin}/invitations/accept?token=${encodeURIComponent(inviteToken)}`;
  }

  function inviteShareText() {
    const url = inviteAcceptUrl();
    const expiry = inviteExpiresAt ? `\nExpires: ${formatDateTime(inviteExpiresAt)}` : '';
    return `You have been invited to an AgreementHub agreement.\nAccept invitation: ${url}\n\nThis secure link is for the intended recipient only. It may expire and is not a password or general sign-in method.${expiry}`;
  }

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error('Copy failed. Select the text manually.');
    }
  }

  async function copyToken() {
    if (!inviteToken) return;
    await copyText(inviteToken, 'Invitation token');
  }

  function shareInviteWhatsApp() {
    const text = inviteShareText();
    if (!text) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  }

  function shareInviteEmail() {
    const text = inviteShareText();
    const subject = encodeURIComponent('AgreementHub invitation');
    window.location.href = `mailto:?subject=${subject}&body=${encodeURIComponent(text)}`;
  }

  async function shareInviteNative() {
    const url = inviteAcceptUrl();
    if (typeof navigator === 'undefined' || !navigator.share || !url) return;
    try {
      await navigator.share({ title: 'AgreementHub invitation', text: inviteShareText(), url });
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') toast.error('Could not open the share menu.');
    }
  }

  return (
    <div className="space-y-5">
      <div className="border-y border-rule bg-sheet">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-ink">Parties</h3>
            <p className="mt-0.5 text-sm text-ink-2">
              {parties.length} part{parties.length === 1 ? 'y' : 'ies'} on this agreement.
            </p>
          </div>
          {canInvite ? (
            <Button size="sm" icon={<MailPlus className="h-4 w-4" />} onClick={() => setInviteOpen(true)}>
              Invite party
            </Button>
          ) : null}
        </div>

        <ul className="divide-y divide-rule">
          {parties.map((party: PartyDetail) => (
            <li key={party.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <Avatar
                name={party.display_name ?? party.email}
                userId={party.user_id}
                src={party.avatarUrl}
                size={32}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {party.display_name ?? party.email}
                </p>
                <p className="truncate text-xs text-ink-2">{party.email}</p>
              </div>
              <RoleBadge role={party.role} />
              <Badge tone={PARTY_STATUS_TONES[party.status] ?? 'neutral'}>
                {partyStatus(party.status)}
              </Badge>
              {party.signing_order > 0 ? (
                <span className="text-xs text-ink-2">Order {party.signing_order}</span>
              ) : null}
              <span className="w-40 text-right text-xs text-ink-3">
                {party.signed_at
                  ? `Signed ${formatDateTime(party.signed_at)}`
                  : `Added ${formatDateTime(party.added_at)}`}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Signature records: immutable and method-labelled (SPEC §13). */}
      {(signaturesQuery.data?.signatures.length ?? 0) > 0 ? (
        <div className="border-y border-rule bg-sheet">
          <div className="border-b border-rule px-5 py-4">
            <h3 className="flex items-center gap-2 text-base font-semibold text-ink">
              <Signature className="h-4 w-4 text-navy" aria-hidden />
              Signature records
            </h3>
            <p className="mt-0.5 text-sm text-ink-2">
              Each record binds signer, timestamp, signing method and the document hash at signing.
              Completed signatures are immutable. They can never be edited or removed.
            </p>
          </div>
          <ul className="divide-y divide-rule">
            {(signaturesQuery.data?.signatures ?? []).map((sig) => (
              <li key={sig.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{sig.signerEmail}</p>
                  <p className="truncate text-xs text-ink-2">
                    Signed {formatDateTime(sig.signedAt)} · consent {sig.consentTextVersion}
                  </p>
                </div>
                <RoleBadge role={sig.partyRole} />
                <Badge tone="info">{signingMethodLabel(sig.method)}</Badge>
                <span
                  className="w-40 text-right font-mono text-xs text-ink-3"
                  title={sig.documentHashAtSigning}
                >
                  {shortHash(sig.documentHashAtSigning)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Accept an invitation (counterparty flow) */}
      <form
        onSubmit={onAccept}
        className="border-y border-rule bg-sheet p-5"
        noValidate
      >
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <TicketCheck className="h-4 w-4 text-navy" aria-hidden />
          Have an invitation token?
        </h3>
        <p className="mt-1 text-sm text-ink-2">
          Paste the one-time token you received to link your account to this agreement.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="flex-1">
            <Input
              aria-label="Invitation token"
              value={acceptToken}
              onChange={(e) => setAcceptToken(e.target.value)}
              placeholder="Paste invitation token"
              className="font-mono text-xs"
              error={acceptError}
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            loading={acceptLoading}
            disabled={acceptToken.trim().length < 10}
          >
            Accept invitation
          </Button>
        </div>
      </form>

      {/* Invite dialog */}
      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title={inviteToken ? 'Invitation created' : 'Invite a party'}
        description={
          inviteToken
            ? 'This secure invitation is shown once. Share it only with the intended recipient through a trusted channel (email or WhatsApp).'
            : 'The invited party accepts using a secure invitation link or token.'
        }
        footer={
          inviteToken ? (
            <Button onClick={() => setInviteOpen(false)}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setInviteOpen(false)}>
                Cancel
              </Button>
              <Button loading={inviteLoading} onClick={onInvite} disabled={!inviteEmail.trim()}>
                Create invite
              </Button>
            </>
          )
        }
      >
        {inviteToken ? (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-ink">Secure accept link</p>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded-control border border-rule bg-paper px-3 py-2 font-mono text-xs break-all">
                  {inviteAcceptUrl()}
                </code>
                <Button variant="secondary" size="sm" icon={<Link2 className="h-4 w-4" />} onClick={() => copyText(inviteAcceptUrl(), 'Invitation link')}>
                  Copy
                </Button>
              </div>
              {inviteExpiresAt ? <p className="mt-1 text-xs text-ink-3">Expires {formatDateTime(inviteExpiresAt)}.</p> : null}
            </div>
            <div>
              <p className="text-sm font-medium text-ink">Invitation token</p>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded-control border border-rule bg-paper px-3 py-2 font-mono text-xs break-all">
                  {inviteToken}
                </code>
                <Button variant="secondary" size="sm" icon={<Copy className="h-4 w-4" />} onClick={copyToken}>
                  Copy
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" icon={<MessageCircle className="h-4 w-4" />} onClick={shareInviteWhatsApp}>
                WhatsApp
              </Button>
              <Button variant="secondary" size="sm" icon={<Mail className="h-4 w-4" />} onClick={shareInviteEmail}>
                Email
              </Button>
              {typeof navigator !== 'undefined' && typeof navigator.share === 'function' ? (
                <Button variant="secondary" size="sm" icon={<Share2 className="h-4 w-4" />} onClick={shareInviteNative}>
                  Share
                </Button>
              ) : null}
              <Button variant="secondary" size="sm" icon={<Copy className="h-4 w-4" />} onClick={() => copyText(inviteShareText(), 'Invitation message')}>
                Copy message
              </Button>
            </div>
            <p className="text-xs text-ink-2">
              Only share with the intended recipient. WhatsApp/email are sharing channels, not authentication or document access. The raw token is never stored server-side; only its hash. If you lose it, issue a new invite.
            </p>
          </div>
        ) : (
          <form onSubmit={onInvite} className="space-y-4" noValidate>
            <Input
              label="Email"
              type="email"
              required
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="counterparty@company.com"
              error={inviteError}
            />
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Role"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
              >
                {PARTY_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r.charAt(0) + r.slice(1).toLowerCase()}
                  </option>
                ))}
              </Select>
              <Input
                label="Signing order"
                type="number"
                min={0}
                max={99}
                value={inviteOrder}
                onChange={(e) => setInviteOrder(e.target.value)}
                hint="0 = no order constraint."
              />
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
