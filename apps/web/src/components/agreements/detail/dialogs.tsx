'use client';

/** Dialogs used by the agreement detail action bar. */
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { CheckCircle2, Copy, GitBranch, Link2, Mail, MessageCircle, Share2, ShieldCheck, XCircle } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { ApiError, post } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { shortHash, signingMethodLabel } from '@/lib/format';
import { VerifyQr } from '@/components/ui/verify-qr';
import type { AmendmentResult, FinalizeResult, SignResult } from '@/lib/types';

/* ------------------------------- share ---------------------------------- */

export function ShareDialog({
  open,
  onClose,
  publicId,
}: {
  open: boolean;
  onClose: () => void;
  publicId: string;
}) {
  const toast = useToast();
  const verifyUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/verify/${publicId}` : '';
  const shareText = `AgreementHub verification (${publicId}): ${verifyUrl}\n\nThis link checks document integrity only. It does not show agreement contents.`;

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied to clipboard.`);
    } catch {
      toast.error('Copy failed. Select the text manually.');
    }
  }

  async function shareNative() {
    if (!verifyUrl || typeof navigator === 'undefined' || !navigator.share) {
      toast.error('Sharing is not available here. Use Copy, WhatsApp, or Email.');
      return;
    }
    try {
      await navigator.share({ title: `Verify agreement ${publicId}`, text: shareText, url: verifyUrl });
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') toast.error('Could not open the share menu.');
    }
  }

  function shareWhatsApp() {
    if (!verifyUrl) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank', 'noopener,noreferrer');
  }

  function shareEmail() {
    if (!verifyUrl) return;
    const subject = encodeURIComponent(`AgreementHub verification: ${publicId}`);
    const body = encodeURIComponent(shareText);
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share & verify"
      description="Verification links show integrity metadata only and never reveal agreement contents."
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium text-ink">Agreement ID</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 truncate rounded-control border border-rule bg-paper px-3 py-2 font-mono text-sm">
              {publicId}
            </code>
            <Button
              variant="secondary"
              size="sm"
              icon={<Copy className="h-4 w-4" />}
              onClick={() => copy(publicId, 'Agreement ID')}
            >
              Copy
            </Button>
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-ink">Public verification link</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 truncate rounded-control border border-rule bg-paper px-3 py-2 font-mono text-xs">
              {verifyUrl}
            </code>
            <Button
              variant="secondary"
              size="sm"
              icon={<Copy className="h-4 w-4" />}
              onClick={() => copy(verifyUrl, 'Verification link')}
            >
              Copy
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" icon={<MessageCircle className="h-4 w-4" />} onClick={shareWhatsApp}>
              WhatsApp
            </Button>
            <Button variant="secondary" size="sm" icon={<Mail className="h-4 w-4" />} onClick={shareEmail}>
              Email
            </Button>
            {typeof navigator !== 'undefined' && typeof navigator.share === 'function' ? (
              <Button variant="secondary" size="sm" icon={<Share2 className="h-4 w-4" />} onClick={shareNative}>
                Share
              </Button>
            ) : null}
          </div>
          <p className="mt-1.5 text-xs text-ink-2">
            Recipients can confirm the document’s integrity with this link. WhatsApp and email are sharing channels only. To let someone edit or sign, invite them from the Parties tab instead.
          </p>
        </div>

        <div className="flex flex-col items-start gap-4 rounded-control border border-rule bg-paper px-3 py-4 sm:flex-row sm:items-center">
          <VerifyQr url={verifyUrl} size={116} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Verification QR code</p>
            <p className="mt-1 text-xs text-ink-2">
              Scanning this code opens the public verification page for{' '}
              <span className="font-mono">{publicId}</span>. It confirms document integrity only.
              It never reveals agreement contents, parties, or terms.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-control border border-rule-strong bg-navy-tint px-3 py-2.5">
          <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-navy" aria-hidden />
          <p className="text-xs text-ink-2">
            Share the <b>verification link</b> freely. Share the Agreement ID only with people who
            are already parties or reviewers of this agreement.
          </p>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------- sign ---------------------------------- */

/** MVP signing methods offered by the dialog. */
type SignMethod = 'TYPED' | 'DRAWN' | 'CONSENT';

const SIGN_METHODS: Array<{ value: SignMethod; label: string; description: string }> = [
  {
    value: 'TYPED',
    label: 'Typed name',
    description: 'Type your full name exactly as it appears in the agreement.',
  },
  {
    value: 'DRAWN',
    label: 'Drawn signature',
    description: 'Draw your signature with a mouse, pen or finger.',
  },
  {
    value: 'CONSENT',
    label: 'Explicit acceptance',
    description: 'Accept electronically using the consent statement below.',
  },
];

export function SignDialog({
  open,
  onClose,
  agreementId,
  title,
  publicId,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  agreementId: string;
  title: string;
  publicId: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [method, setMethod] = useState<SignMethod>('TYPED');
  const [name, setName] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SignResult | null>(null);
  const [drawnUrl, setDrawnUrl] = useState<string | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const hasInkRef = useRef(false);

  useEffect(() => {
    if (open) {
      setStep(0);
      setMethod('TYPED');
      setName('');
      setConfirmed(false);
      setError(null);
      setResult(null);
      setDrawnUrl(null);
      clearInk();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function clearInk() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInkRef.current = false;
    setHasInk(false);
  }

  function inkPoint(e: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // Map CSS pixels to the canvas backing store (the canvas is scaled by CSS).
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function startInk(e: ReactPointerEvent<HTMLCanvasElement>) {
    const ctx = canvasRef.current?.getContext('2d');
    const p = inkPoint(e);
    if (!ctx || !p) return;
    drawingRef.current = true;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Some pointers (synthetic or already released) cannot be captured;
      // drawing still works without capture.
    }
  }

  function moveInk(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    const p = inkPoint(e);
    if (!ctx || !p) return;
    ctx.strokeStyle = canvasRef.current
      ? getComputedStyle(canvasRef.current).getPropertyValue('--color-ink').trim() || 'currentColor'
      : 'currentColor';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!hasInkRef.current) {
      hasInkRef.current = true;
      setHasInk(true);
    }
  }

  function endInk() {
    drawingRef.current = false;
  }

  const canSign =
    confirmed &&
    (method !== 'TYPED' || name.trim().length > 0) &&
    (method !== 'DRAWN' || hasInk);

  async function onSign(e: FormEvent) {
    e.preventDefault();
    if (!canSign) return;
    setLoading(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { agreementId, consent: true, method };
      if (method === 'TYPED') payload.signatureText = name.trim();
      if (method === 'DRAWN') {
        const url = canvasRef.current?.toDataURL('image/png') ?? '';
        payload.signatureData = url;
        setDrawnUrl(url);
      }
      const res = await post<SignResult>('/signatures', payload);
      setResult(res);
      toast.success('Signature recorded.');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Signing failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (result) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="Signature recorded"
        footer={
          <Button onClick={onClose} variant={secondaryVariant(result.allSigned)}>
            {result.allSigned ? 'Done' : 'Close'}
          </Button>
        }
      >
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-control border border-seal-rule bg-seal-tint px-3 py-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-seal" aria-hidden />
            <div className="text-sm text-ink">
              <p className="font-medium">You signed “{title}”.</p>
              <p className="mt-1 text-ink-2">
                {result.allSigned
                  ? 'All required signatures are collected. The agreement is ready to be finalized.'
                  : `${result.missingSignatures} signature${result.missingSignatures === 1 ? '' : 's'} still outstanding.`}
              </p>
            </div>
          </div>
          {drawnUrl && result.signature.method === 'DRAWN' ? (
            <div className="rounded-control border border-rule bg-sheet px-3 py-2">
              <img src={drawnUrl} alt="Your drawn signature" className="mx-auto h-20" />
            </div>
          ) : null}
          <dl className="grid grid-cols-1 gap-2 rounded-control border border-rule bg-paper px-3 py-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-ink-2">Signing method</dt>
              <dd className="text-xs font-medium text-ink">
                {signingMethodLabel(result.signature.method)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-2">Signature hash</dt>
              <dd className="font-mono text-xs">{shortHash(result.signature.documentHashAtSigning)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-2">Consent record</dt>
              <dd className="font-mono text-xs">{result.signature.consentTextVersion}</dd>
            </div>
          </dl>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sign agreement"
      description={`Signing ${publicId} creates a legally-relevant electronic acceptance record.`}
      footer={
        step < 2 ? (
          <>
            <Button variant="secondary" onClick={step === 0 ? onClose : () => setStep(step - 1)}>
              {step === 0 ? 'Cancel' : 'Back'}
            </Button>
            <Button
              onClick={() => setStep(step + 1)}
              disabled={step === 1 && !confirmed}
            >
              Continue
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button
              onClick={onSign}
              loading={loading}
              disabled={!canSign}
              icon={<ShieldCheck className="h-4 w-4" />}
            >
              Sign now
            </Button>
          </>
        )
      }
    >
      <form onSubmit={onSign} className="space-y-5" noValidate>
        {/* Three steps: Review → Consent → Sign. */}
        <ol className="flex items-center gap-2" aria-label="Signing steps">
          {['Review', 'Consent', 'Sign'].map((label, index) => (
            <li key={label} className="flex flex-1 items-center gap-2 last:flex-none">
              <span
                className={`inline-flex h-6 w-6 items-center justify-center rounded-control border text-xs font-medium ${
                  index < step
                    ? 'border-navy bg-navy text-sheet'
                    : index === step
                      ? 'border-navy text-navy'
                      : 'border-rule-strong text-ink-3'
                }`}
                aria-current={index === step ? 'step' : undefined}
              >
                {index < step ? <CheckCircle2 className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <span className={`text-caps ${index === step ? 'text-ink' : 'text-ink-3'}`}>{label}</span>
              {index < 2 ? <span className="h-px flex-1 bg-rule" aria-hidden /> : null}
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <div className="space-y-4">
            <div className="border-y border-rule bg-paper/60 px-4 py-4">
              <p className="text-caps text-ink-3">You are signing</p>
              <p className="mt-1 font-serif text-lg text-ink">{title}</p>
              <p className="mt-1 font-mono text-xs text-ink-2">{publicId}</p>
            </div>
            <div className="space-y-2 text-sm text-ink-2">
              <p>
                Read the document carefully before continuing. Your signature will bind you to the
                exact content shown in the current version.
              </p>
              <p>
                Any later change creates a new version and invalidates this signature. It would need
                to be signed again.
              </p>
            </div>
            <div className="border-l-2 border-rule-strong pl-3">
              <p className="text-caps text-ink-3">Recorded</p>
              <p className="mt-1 text-xs text-ink-2">
                Signer, timestamp, signing method, consent text version, and the document hash at the
                moment of signing.
              </p>
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="space-y-4">
            <div className="border-l-2 border-navy bg-navy-tint px-4 py-3 text-sm text-ink">
              <p className="font-medium">Electronic signature consent</p>
              <p className="mt-1 text-ink-2">
                By selecting “Sign now” you confirm that: (1) you have reviewed this agreement,
                (2) you intend to be legally bound by it, and (3) your electronic signature is
                equivalent to your handwritten signature. Your signature is bound to the exact
                document content at this moment. Any later change creates a new version requiring a
                new signature.
              </p>
            </div>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-control border border-rule-strong bg-sheet px-3 py-3 text-sm text-ink">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-navy)]"
              />
              <span>I have read and agree to the electronic signature consent above.</span>
            </label>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-4">
            <fieldset>
              <legend className="text-sm font-medium text-ink">Signing method</legend>
              <p className="mt-0.5 text-xs text-ink-2">
                The method you choose is recorded and labelled on the signature record.
              </p>
              <div className="mt-2 space-y-1.5">
                {SIGN_METHODS.map((option) => (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer items-start gap-2.5 rounded-control border px-3 py-2.5 ${
                      method === option.value
                        ? 'border-navy bg-navy-tint'
                        : 'border-rule bg-sheet hover:bg-vellum'
                    }`}
                  >
                    <input
                      type="radio"
                      name="signing-method"
                      checked={method === option.value}
                      onChange={() => setMethod(option.value)}
                      className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-navy)]"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">{option.label}</span>
                      <span className="block text-xs text-ink-2">{option.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {method === 'TYPED' ? (
              <div className="space-y-3">
                <Input
                  label="Type your full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  hint="Must match the name you are signing as."
                  placeholder="Jordan Rivera"
                  required
                />
                <div className="rounded-control border border-rule bg-paper px-4 py-4">
                  <p className="text-caps text-ink-3">Signature preview</p>
                  <p
                    className="mt-1 min-h-[2.5rem] text-ink"
                    style={{ fontFamily: "'Mrs Saint Delafield', 'Segoe Script', 'Bradley Hand', cursive", fontSize: '2rem', lineHeight: 1.1 }}
                    aria-live="polite"
                  >
                    {name.trim() || '\u00A0'}
                  </p>
                </div>
              </div>
            ) : null}

            {method === 'DRAWN' ? (
              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="sig-canvas" className="text-sm font-medium text-ink">
                    Draw your signature
                  </label>
                  <Button type="button" variant="secondary" size="sm" onClick={clearInk} disabled={!hasInk}>
                    Clear
                  </Button>
                </div>
                <canvas
                  id="sig-canvas"
                  ref={canvasRef}
                  width={640}
                  height={200}
                  onPointerDown={startInk}
                  onPointerMove={moveInk}
                  onPointerUp={endInk}
                  onPointerLeave={endInk}
                  className="mt-1.5 h-40 w-full touch-none rounded-control border border-rule-strong bg-sheet"
                />
                <p className="mt-1 text-xs text-ink-2">
                  {hasInk
                    ? 'Signature captured. Continue below.'
                    : 'Draw with your mouse, pen or finger.'}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div className="border-l-2 border-danger bg-danger-tint px-3 py-2.5 text-sm text-danger" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

function secondaryVariant(allSigned: boolean) {
  return allSigned ? 'primary' : 'secondary';
}

/* ------------------------------- approval -------------------------------- */

export function ApprovalDialog({
  open,
  onClose,
  agreementId,
  decision,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  agreementId: string;
  decision: 'APPROVED' | 'REJECTED';
  onDone: () => void;
}) {
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setComment('');
      setError(null);
    }
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await post(`/approvals`, {
        agreementId,
        decision,
        comment: comment.trim() || undefined,
      });
      toast.success(decision === 'APPROVED' ? 'Approval recorded.' : 'Rejection recorded.');
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record your decision.');
    } finally {
      setLoading(false);
    }
  }

  const approving = decision === 'APPROVED';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={approving ? 'Approve this version' : 'Reject this version'}
      description={
        approving
          ? 'Your approval counts toward the template’s approval policy.'
          : 'Rejecting sends the agreement back for changes.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={approving ? 'primary' : 'danger'}
            loading={loading}
            onClick={onSubmit}
            icon={approving ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          >
            {approving ? 'Approve' : 'Reject'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Textarea
          label={approving ? 'Note (optional)' : 'Reason (optional)'}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={approving ? 'Any conditions or context…' : 'What needs to change?'}
          rows={3}
        />
        {error ? (
          <div className="rounded-control border border-danger-rule bg-danger-tint px-3 py-2.5 text-sm text-danger" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

/* ----------------------------- reason dialog ----------------------------- */

export function ReasonDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The action failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep as is
          </Button>
          <Button variant="danger" loading={loading} onClick={onSubmit} disabled={reason.trim().length < 3}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Textarea
          label="Reason"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Recorded permanently in the audit trail (min. 3 characters)."
          rows={3}
          error={error}
        />
      </form>
    </Modal>
  );
}

/* --------------------------- create version dialog ----------------------- */

export function CreateVersionDialog({
  open,
  onClose,
  agreementId,
  currentVersionNumber,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  agreementId: string;
  currentVersionNumber: number;
  onDone: () => void;
}) {
  const toast = useToast();
  const [summary, setSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setSummary('');
      setError(null);
    }
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await post(`/versions`, { agreementId, changeSummary: summary.trim() });
      toast.success(`Version ${currentVersionNumber + 1} created. v${currentVersionNumber} is now frozen.`);
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the version.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Create version ${currentVersionNumber + 1}`}
      description={`Version ${currentVersionNumber} will be frozen permanently. Continue editing on the new working copy.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={loading} onClick={onSubmit} disabled={summary.trim().length < 3}>
            Create version
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Textarea
          label="Change summary"
          required
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="e.g. Updated payment terms and shortened the notice period"
          rows={3}
          error={error}
          hint="Stored with the version and shown in the history (min. 3 characters)."
        />
      </form>
    </Modal>
  );
}

/* --------------------------- amendment dialog -------------------------- */

/**
 * Post-finalization changes: seeds a new working version from the sealed
 * final document and re-opens negotiation. The final version itself keeps its
 * FINAL status and hash forever. Verification of the sealed document never
 * breaks because an amendment is in progress.
 */
export function AmendmentDialog({
  open,
  onClose,
  agreementId,
  finalVersionNumber,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  agreementId: string;
  finalVersionNumber: number;
  onDone: () => void;
}) {
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  async function onSubmit() {
    setLoading(true);
    setError(null);
    try {
      const res = await post<AmendmentResult>(`/agreements/${agreementId}/amendments`, {});
      toast.success(
        `Amendment started. v${res.version.versionNumber} created from sealed v${res.finalVersionNumber}.`,
      );
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the amendment.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start an amendment"
      description="Re-open negotiation on a finalized agreement without touching the sealed document."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={loading}
            onClick={onSubmit}
            icon={<GitBranch className="h-4 w-4" />}
          >
            Start amendment
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-ink">
        <p>
          A new working version is created as an exact copy of the sealed document
          {finalVersionNumber > 0 ? ` (v${finalVersionNumber})` : ''}, and the agreement returns to
          negotiation for editing.
        </p>
        <ul className="space-y-1.5 rounded-control border border-rule bg-paper px-3 py-2.5 text-ink-2">
          <li>• The final version keeps its FINAL status, hash, and public verification.</li>
          <li>• Every edit from here creates a new version with its own audit trail.</li>
          <li>• A later re-seal produces a new final version for the amended document.</li>
        </ul>
        {error ? (
          <div className="rounded-control border border-danger-rule bg-danger-tint px-3 py-2.5 text-danger" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
