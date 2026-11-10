'use client';

/**
 * SealCeremony, the three-step finalization ritual:
 *   1 Review  2 Consent  3 Seal (press and hold).
 *
 * Press-and-hold is deliberate: sealing is irreversible and should feel so.
 * The hold also works with keyboard (Space/Enter) and is announced politely.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { HashText } from '@/components/ui/hash-text';
import { Modal } from '@/components/ui/modal';
import { Rosette } from '@/components/ui/rosette';
import { StatusGlyph } from '@/components/ui/status-stamp';

const HOLD_MS = 1400;
const RING = 2 * Math.PI * 26;

export function SealCeremony({
  open,
  onClose,
  publicId,
  versionNumber,
  documentHash,
  signerSummary,
  busy = false,
  onSeal,
}: {
  open: boolean;
  onClose: () => void;
  publicId: string;
  versionNumber: number;
  documentHash: string | null | undefined;
  signerSummary?: string;
  busy?: boolean;
  onSeal: () => void | Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [consented, setConsented] = useState(false);
  const [progress, setProgress] = useState(0);
  const [sealed, setSealed] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      setStep(0);
      setConsented(false);
      setProgress(0);
      setSealed(false);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, []);

  function stop() {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    setProgress(0);
  }

  function begin() {
    if (busy || sealed || timer.current) return;
    const started = Date.now();
    timer.current = window.setInterval(() => {
      const ratio = Math.min(1, (Date.now() - started) / HOLD_MS);
      setProgress(ratio);
      if (ratio >= 1) {
        stop();
        setSealed(true);
        void onSeal();
      }
    }, 16);
  }

  const labels = ['Review', 'Consent', 'Seal'];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Seal this agreement"
      description="Sealing is irreversible. The document hash is frozen and published to the public verification record."
      size="md"
      footer={
        step === 0 ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => setStep(1)}>Continue to consent</Button>
          </>
        ) : step === 1 ? (
          <>
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button disabled={!consented} onClick={() => setStep(2)}>
              Continue to seal
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <span className="self-center text-xs text-ink-2">
              {sealed ? 'Sealed. Publishing the record…' : 'Press and hold to seal'}
            </span>
          </>
        )
      }
    >
      {/* Progress rail */}
      <ol className="mb-6 flex items-center gap-2" aria-label="Sealing steps">
        {labels.map((label, index) => (
          <li key={label} className="flex flex-1 items-center gap-2 last:flex-none">
            <span
              className={`inline-flex h-6 w-6 items-center justify-center rounded-control border text-xs font-medium ${
                index < step
                  ? 'border-seal bg-seal text-sheet'
                  : index === step
                    ? 'border-navy text-navy'
                    : 'border-rule-strong text-ink-3'
              }`}
              aria-current={index === step ? 'step' : undefined}
            >
              {index < step ? <StatusGlyph name="approved" className="h-3.5 w-3.5" /> : index + 1}
            </span>
            <span
              className={`text-caps ${index === step ? 'text-ink' : 'text-ink-3'}`}
            >
              {label}
            </span>
            {index < labels.length - 1 ? <span className="h-px flex-1 bg-rule" aria-hidden /> : null}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <div className="flex flex-col items-center gap-4 text-center">
          <Rosette hash={documentHash} size={128} className="text-navy" />
          <dl className="w-full divide-y divide-rule border-y border-rule text-left text-sm">
            <div className="flex justify-between gap-4 py-2">
              <dt className="text-ink-2">Agreement</dt>
              <dd className="font-mono text-xs text-ink">{publicId}</dd>
            </div>
            <div className="flex justify-between gap-4 py-2">
              <dt className="text-ink-2">Version</dt>
              <dd className="text-ink">v{versionNumber}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2 py-2">
              <dt className="text-ink-2">Document hash</dt>
              <dd>
                <HashText value={documentHash} copyable={false} />
              </dd>
            </div>
            {signerSummary ? (
              <div className="flex justify-between gap-4 py-2">
                <dt className="text-ink-2">Signatures</dt>
                <dd className="text-ink">{signerSummary}</dd>
              </div>
            ) : null}
          </dl>
          <p className="max-w-prose text-sm text-ink-2">
            Confirm these details before proceeding. Once sealed, the content, signatures, and PDF
            digest can no longer be changed; they can only be amended through a new version.
          </p>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="space-y-4">
          <div className="border-l-2 border-attention bg-attention-tint px-4 py-3">
            <p className="text-caps text-attention">Irreversible</p>
            <p className="mt-1 text-sm text-ink">
              Sealing freezes the document hash, writes the final audit entry, and publishes
              verification for <span className="font-mono text-xs">{publicId}</span>.
            </p>
          </div>
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-control border border-rule-strong bg-sheet px-3 py-3">
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-navy)]"
            />
            <span className="text-sm text-ink">
              I have reviewed the final document and understand that sealing cannot be undone.
            </span>
          </label>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="flex flex-col items-center gap-4">
          <div className="relative flex h-32 w-32 items-center justify-center">
            <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden>
              <circle cx="32" cy="32" r="26" fill="none" stroke="var(--color-rule)" strokeWidth="2" />
              <circle
                cx="32"
                cy="32"
                r="26"
                fill="none"
                stroke="var(--color-seal)"
                strokeWidth="2"
                strokeDasharray={RING}
                strokeDashoffset={RING * (1 - progress)}
                strokeLinecap="butt"
              />
            </svg>
            <button
              type="button"
              onPointerDown={begin}
              onPointerUp={stop}
              onPointerLeave={stop}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  begin();
                }
              }}
              onKeyUp={stop}
              disabled={busy || sealed}
              aria-label="Press and hold to seal this agreement"
              className="relative z-10 flex h-24 w-24 flex-col items-center justify-center rounded-control border border-seal bg-seal-tint text-seal transition-colors hover:bg-seal hover:text-sheet disabled:opacity-60 [touch-action:none]"
            >
              <StatusGlyph name="active" className="h-6 w-6" />
              <span className="mt-1 text-caps">{sealed ? 'Sealed' : 'Hold'}</span>
            </button>
          </div>
          <p aria-live="polite" className="text-center text-sm text-ink-2">
            {sealed
              ? 'Seal applied. Writing the final ledger entry.'
              : 'Press and hold the seal for a moment to confirm.'}
          </p>
          <HashText value={documentHash} copyable={false} />
        </div>
      ) : null}
    </Modal>
  );
}
