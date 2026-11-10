'use client';

/**
 * PUBLIC verification (SPEC §14): a certificate, not a dashboard.
 * Metadata and integrity only, never agreement contents or parties.
 * Distinguishes: valid/intact, modified/tampered, revoked/lifecycle-ended, unavailable.
 */
import Link from 'next/link';
import { use, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import type { VerificationRecordState, VerificationResponse } from '@/lib/types';
import { Rosette, RosetteMark } from '@/components/ui/rosette';
import { HashText } from '@/components/ui/hash-text';
import { Sheet, SheetBody, SheetFooter } from '@/components/ui/sheet';
import { StatusStamp, StatusGlyph } from '@/components/ui/status-stamp';
import { VerifyQr } from '@/components/ui/verify-qr';
import { Skeleton } from '@/components/ui/states';
import { useDelayedPending } from '@/lib/use-delayed-pending';
import { formatDate, formatDateTime, statusLabel } from '@/lib/format';

type CheckState = 'VERIFIED' | 'MISMATCH' | 'NOT_AVAILABLE' | 'UNVERIFIED';

function recordStateOf(data: VerificationResponse): VerificationRecordState {
  if (data.recordState) return data.recordState;
  if (!data.found || data.integrity === 'NOT_FOUND') return 'UNAVAILABLE';
  if (data.integrity === 'MISMATCH') return 'MODIFIED';
  if (['EXPIRED', 'TERMINATED', 'CANCELLED', 'REJECTED'].includes(String(data.status ?? ''))) return 'REVOKED';
  return 'VALID';
}

function CheckLine({ label, state, note }: { label: string; state: CheckState; note?: string }) {
  const glyph = state === 'VERIFIED' ? 'approved' : state === 'MISMATCH' ? 'rejected' : 'expired';
  const tone =
    state === 'VERIFIED'
      ? 'text-seal'
      : state === 'MISMATCH'
        ? 'text-danger'
        : 'text-attention';
  const suffix =
    state === 'UNVERIFIED'
      ? 'legacy record, snapshot unavailable'
      : state === 'NOT_AVAILABLE'
        ? 'not available'
        : null;
  return (
    <li className="flex items-start gap-2 border-b border-rule py-2 last:border-b-0">
      <StatusGlyph name={glyph} className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} />
      <span className="min-w-0 flex-1 text-sm text-ink">
        {label}
        {note ? <span className="text-ink-2"> — {note}</span> : null}
      </span>
      <span className={`text-caps ${tone}`}>{suffix ?? state.replace('_', ' ').toLowerCase()}</span>
    </li>
  );
}

function Certificate({ data }: { data: VerificationResponse }) {
  const state = recordStateOf(data);
  const message =
    data.recordMessage ??
    (state === 'UNAVAILABLE'
      ? 'This record cannot be verified as authentic from the available evidence.'
      : state === 'MODIFIED'
        ? 'Integrity checks did not pass. The presented evidence may have been modified or replaced.'
        : state === 'REVOKED'
          ? 'The sealed evidence was checked, but the agreement lifecycle has ended.'
          : 'Available integrity checks for the sealed record passed.');

  if (state === 'UNAVAILABLE') {
    const exists = data.found;
    return (
      <Sheet label="Verification result">
        <SheetBody className="flex flex-col items-center py-12 text-center">
          <Rosette hash={data.agreementId ?? 'not-found'} size={112} className="text-ink-3" decorative />
          <p className={`mt-5 text-caps ${exists ? 'text-attention' : 'text-ink-3'}`}>
            {exists ? 'Record unavailable for verification' : 'No matching record'}
          </p>
          <h1 className="mt-2 font-serif text-xl text-ink">
            {exists ? 'Not yet sealed or evidence unavailable' : 'Agreement not found'}
          </h1>
          <p className="mt-2 max-w-md text-sm text-ink-2">
            {data.agreementId ? (
              <>
                Reference <span className="font-mono text-xs text-ink">{data.agreementId}</span>.{' '}
              </>
            ) : null}
            {message}
          </p>
          {!exists ? (
            <p className="mt-3 max-w-md text-xs text-ink-3">
              A reference alone does not confirm authenticity. Check the ID for typos or ask the sender to share the official verification link.
            </p>
          ) : null}
          {data.status || data.lifecycleLabel ? (
            <p className="mt-3 text-xs text-ink-3">
              Lifecycle status: <b>{data.lifecycleLabel ?? (data.status ? statusLabel(String(data.status)) : 'unknown')}</b>
            </p>
          ) : null}
          {data.createdAt ? <p className="mt-2 text-xs text-ink-3">Created {formatDate(data.createdAt)}</p> : null}
        </SheetBody>
      </Sheet>
    );
  }

  if (state === 'MODIFIED') {
    const failed = [
      data.contentIntegrity === 'MISMATCH' ? 'canonical content' : null,
      data.pdfIntegrity === 'MISMATCH' ? 'finalized PDF bytes' : null,
      data.signatureIntegrity === 'MISMATCH' ? 'signature records' : null,
    ].filter(Boolean);
    return (
      <Sheet label="Verification failed">
        <div className="watermark" aria-hidden>
          Modified
        </div>
        <SheetBody className="relative flex flex-col items-center border-b-4 border-danger py-12 text-center">
          <Rosette hash={data.pdfHash ?? data.agreementId ?? 'mismatch'} size={112} className="text-danger" decorative />
          <p className="mt-5 text-caps text-danger">Modified or tampered</p>
          <h1 className="mt-2 font-serif text-xl text-ink">This record does not match</h1>
          <p className="mt-2 max-w-lg text-sm text-ink-2">
            Reference <span className="font-mono text-xs text-ink">{data.agreementId}</span>. {message}
            {failed.length > 0 ? ` Failed checks: ${failed.join(', ')}.` : ''}
          </p>
          {data.pdfHash && data.pdfIntegrity === 'MISMATCH' ? (
            <p className="mt-3 max-w-lg text-xs text-ink-2">
              The PDF you presented does not match the registered final PDF digest{' '}
              <span className="font-mono text-ink">{data.pdfHashPrefix}…</span>.
            </p>
          ) : null}
          <p className="mt-4 max-w-lg border-l-2 border-danger pl-3 text-left text-xs text-ink-2">
            Do not rely on this copy. Ask the sender for the document linked from the official verification record, or contact them through a channel you already trust.
          </p>
        </SheetBody>
      </Sheet>
    );
  }

  const revoked = state === 'REVOKED';
  const accent = revoked ? 'text-attention border-attention bg-attention/5' : 'text-seal border-seal-rule bg-seal-tint';
  const rosetteClass = revoked ? 'text-attention' : 'text-seal';

  return (
    <Sheet label={revoked ? 'Verification result — lifecycle ended' : 'Certificate of integrity'}>
      <div className="hairline-double mx-6 mt-6 flex flex-wrap items-center justify-between gap-4 px-1 py-3 sm:mx-8">
        <div>
          <p className="text-caps text-ink-3">AgreementHub · public register</p>
          <h1 className="mt-1 font-serif text-xl text-ink">
            {revoked ? 'Sealed record — lifecycle ended' : 'Certificate of integrity'}
          </h1>
        </div>
        <span className={`inline-flex items-center gap-2 border px-3 py-1.5 text-sm font-medium ${accent}`}>
          <StatusGlyph name={revoked ? 'expired' : 'approved'} className="h-4 w-4" />
          {revoked ? data.lifecycleLabel ?? 'Lifecycle ended' : 'Integrity intact'}
        </span>
      </div>

      <SheetBody className="relative">
        <div className="flex flex-col items-center text-center">
          <Rosette hash={data.hashPrefix ?? data.agreementId} size={128} className={rosetteClass} />
          <p className="mt-4 max-w-lg text-sm text-ink-2">
            Reference <span className="font-mono text-xs text-ink">{data.agreementId}</span>. {message}
          </p>
          {revoked ? (
            <p className="mt-3 max-w-lg border-l-2 border-attention pl-3 text-left text-xs text-ink-2">
              Integrity of the sealed evidence is reported separately below. A lifecycle status of{' '}
              {data.lifecycleLabel ?? (data.status ? statusLabel(String(data.status)) : 'ended')} does not, by itself, prove the
              document was altered — and an intact record does not prove current legal effect.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {data.status ? <StatusStamp status={String(data.status)} /> : null}
            <span className="inline-flex items-center gap-1 border border-rule-strong px-2 py-0.5 text-xs text-ink-2">
              Version {data.version ?? '—'}
            </span>
          </div>
        </div>

        <div className="mt-8">
          <p className="text-caps text-ink-3">Integrity checklist</p>
          <ul className="mt-1">
            <CheckLine label="Agreement found" state="VERIFIED" />
            <CheckLine label={`Final version${data.version ? ` (v${data.version} sealed)` : ''}`} state="VERIFIED" />
            <CheckLine label="Canonical content hash" state={data.contentIntegrity} />
            <CheckLine label="Finalized PDF bytes" state={data.pdfIntegrity} />
            <CheckLine
              label="Signature records"
              state={data.signatureIntegrity}
              note={`${data.signatures.verified} of ${data.signatures.total} verified`}
            />
          </ul>
        </div>

        <dl className="mt-8 grid grid-cols-1 gap-px border border-rule bg-rule sm:grid-cols-2">
          {[
            ['Agreement ID', data.agreementId ?? '—', true],
            ['Category', data.category ?? '—', false],
            ['Lifecycle status', data.lifecycleLabel ?? (data.status ? statusLabel(String(data.status)) : '—'), false],
            ['Sealed version', data.version ? `Version ${data.version}` : '—', false],
            ['Finalized', formatDateTime(data.finalizedAt), false],
            ['Created', formatDate(data.createdAt), false],
          ].map(([label, value, mono]) => (
            <div key={String(label)} className="bg-sheet px-5 py-3.5">
              <dt className="text-caps text-ink-3">{label}</dt>
              <dd className={`mt-1 text-sm text-ink ${mono ? 'font-mono text-xs' : ''}`}>{String(value)}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-6 space-y-4">
          <div>
            <p className="text-caps text-ink-3">Content hash</p>
            <HashText value={data.hashPrefix} className="mt-1" blocks={4} />
          </div>
          <div>
            <p className="text-caps text-ink-3">Final PDF hash</p>
            <HashText value={data.pdfHash ?? data.pdfHashPrefix} className="mt-1" blocks={4} />
          </div>
        </div>

        <div className="mt-8 flex flex-col items-start gap-5 border-t border-rule pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Scan to verify</p>
            <p className="mt-1 max-w-md text-xs text-ink-2">
              This code encodes the verification URL for <span className="font-mono text-ink">{data.agreementId}</span>. Re-scanning
              re-opens this result and re-checks the registered PDF digest when available.
            </p>
          </div>
          <VerifyQr
            url={
              typeof window !== 'undefined' && data.agreementId
                ? `${window.location.origin}/verify/${data.agreementId}${data.pdfHash ? `?pdfHash=${data.pdfHash}` : ''}`
                : ''
            }
            size={124}
            caption={data.pdfHash ? 'A replaced PDF is detected on re-scan.' : undefined}
          />
        </div>
      </SheetBody>

      <SheetFooter>
        <p className="text-xs text-ink-3">
          {data.disclaimer ??
            'This check reports document integrity and lifecycle metadata only. It does not display agreement contents and does not constitute legal advice or proof of enforceability.'}
        </p>
      </SheetFooter>
    </Sheet>
  );
}

export default function VerifyPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = use(params);
  const [id, setId] = useState(publicId.toUpperCase());

  const pdfHash = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('pdfHash') : null;
  const validPdfHash = pdfHash && /^[0-9a-f]{64}$/.test(pdfHash) ? pdfHash : null;

  const query = useQuery({
    queryKey: ['verify', publicId.toUpperCase(), validPdfHash],
    queryFn: () =>
      get<VerificationResponse>(
        `/verification/${publicId.toUpperCase()}${validPdfHash ? `?pdfHash=${validPdfHash}` : ''}`,
      ),
    retry: false,
  });
  const showPending = useDelayedPending(query.isPending);

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 w-full max-w-2xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5" aria-label="AgreementHub home">
            <RosetteMark size={24} className="text-ink" />
            <span className="font-serif text-[1.05rem] font-medium text-ink">AgreementHub</span>
          </Link>
          <span className="text-caps text-ink-3">Public verification</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-9 sm:px-6 sm:py-12">
        {query.isPending ? (
          showPending ? (
            <div
              className="border border-rule bg-sheet p-8"
              role="status"
              aria-live="polite"
              aria-busy="true"
              aria-label="Loading"
            >
              <Skeleton className="mx-auto h-28 w-28" />
              <Skeleton className="mx-auto mt-5 h-px w-56" />
              <Skeleton className="mx-auto mt-3 h-px w-80 max-w-full" />
              <div className="mt-8 space-y-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-px w-full" />
                ))}
              </div>
            </div>
          ) : (
            <div className="min-h-[24rem]" aria-busy="true" aria-live="polite" />
          )
        ) : query.isError ? (
          <div className="border-l-2 border-danger bg-danger-tint px-6 py-8">
            <p className="text-caps text-danger">Unavailable</p>
            <h1 className="mt-1 font-serif text-xl text-ink">Verification could not be reached</h1>
            <p className="mt-1.5 text-sm text-ink-2">The verification service could not be reached. Try again in a moment.</p>
          </div>
        ) : (
          <div className="content-fade-in">
            <Certificate data={query.data!} />
          </div>
        )}

        <div className="mt-8 border-t border-rule pt-5">
          <h2 className="font-serif text-lg text-ink">Check another agreement</h2>
          <p className="mt-1 text-sm text-ink-2">
            Verification never reveals document contents. It reports whether sealed evidence matches registered integrity records and shows lifecycle context.
          </p>
          <form
            className="mt-3"
            onSubmit={(e) => {
              e.preventDefault();
              const next = id.trim().toUpperCase();
              if (next) window.location.href = `/verify/${next}`;
            }}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                aria-label="Agreement ID"
                placeholder="AGR-GH-2026-000001"
                className="min-h-11 flex-1 border border-rule-strong bg-sheet px-3 font-mono text-sm text-ink placeholder:text-ink-3 focus:border-navy focus:ring-2 focus:ring-navy/30 focus:outline-none"
              />
              <button
                type="submit"
                className="inline-flex min-h-11 items-center justify-center border border-navy bg-navy px-4 text-sm font-medium text-sheet hover:bg-navy-hover"
              >
                Verify
              </button>
            </div>
          </form>
        </div>

        <p className="mt-6 text-xs text-ink-3">
          {query.data?.disclaimer ??
            'This check reports document integrity and lifecycle metadata only. It does not display agreement contents and does not constitute legal advice or proof of enforceability.'}
        </p>
      </main>
    </div>
  );
}
