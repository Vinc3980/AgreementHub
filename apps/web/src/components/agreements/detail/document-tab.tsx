'use client';

/**
 * The document tab: a sheet of record, with marginalia for provenance.
 * Sections are set in Newsreader; only inserted text uses the redline
 * convention. Actions remain preview / print / download.
 */
import { useEffect, useRef, useState } from 'react';
import { Download, Printer, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { VersionStamp } from '@/components/ui/status-stamp';
import { HashText } from '@/components/ui/hash-text';
import { Marginalia } from '@/components/ui/marginalia';
import { Rosette } from '@/components/ui/rosette';
import { Sheet, SheetBody, SheetFooter, SheetHeader } from '@/components/ui/sheet';
import { formatDate } from '@/lib/format';
import type { AgreementDetailResponse } from '@/lib/types';

export function DocumentTab({ detail }: { detail: AgreementDetailResponse }) {
  const { sections, fields, currentVersion, agreement, parties } = detail;
  const included = sections.filter((s) => s.included);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewViewportRef = useRef<HTMLDivElement>(null);
  const [previewScale, setPreviewScale] = useState(1);

  const versionNo = currentVersion?.versionNumber ?? 1;
  const isFinal = currentVersion?.status === 'FINAL';
  const base = `/api/v1/agreements/${agreement.id}/documents/${versionNo}`;
  const previewUrl = `${base}/preview`;
  const pdfUrl = `${base}/pdf`;
  const cacheKey = `${versionNo}:${currentVersion?.status ?? 'NONE'}`;

  useEffect(() => {
    if (!previewOpen) return;
    const el = previewViewportRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      // Scale the 820px sheet down on narrow viewports (e.g. 375px) to fit width.
      setPreviewScale(w > 0 ? Math.min(1, w / 820) : 1);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [previewOpen, previewHtml, previewLoading]);

  async function openPreview() {
    setPreviewOpen(true);
    setPreviewError(null);
    if (previewKey === cacheKey && previewHtml) return;
    setPreviewLoading(true);
    try {
      const res = await fetch(previewUrl, { credentials: 'include' });
      if (!res.ok) throw new Error(`Preview failed (HTTP ${res.status}).`);
      const html = await res.text();
      setPreviewHtml(html);
      setPreviewKey(cacheKey);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Preview failed.');
    } finally {
      setPreviewLoading(false);
    }
  }

  return (
    <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_15rem]">
      <div className="min-w-0">
        <Sheet
          label={`Document ${agreement.publicId}`}
          watermark={isFinal ? 'Final' : 'Draft'}
        >
          <SheetHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-caps text-ink-3">The instrument</p>
                <h2 className="mt-2 max-w-2xl font-serif text-xl leading-snug text-ink">
                  {agreement.title}
                </h2>
                <p className="mt-2 font-mono text-xs text-ink-3">{agreement.publicId}</p>
              </div>
              <div className="flex flex-col items-end gap-2">
                {currentVersion ? <VersionStamp status={currentVersion.status} /> : null}
                <span
                  className={`text-caps ${isFinal ? 'text-seal' : 'text-attention'}`}
                >
                  {isFinal ? 'Final agreement' : 'Draft: not final'}
                </span>
              </div>
            </div>
          </SheetHeader>

          <SheetBody className="space-y-8">
            {included.length === 0 ? (
              <p className="border-y border-dashed border-rule-strong py-10 text-center font-serif text-base text-ink-2">
                No sections in this draft yet. Edit the agreement to add content.
              </p>
            ) : (
              included.map((section, index) => (
                <article key={section.id} className="doc-prose">
                  <h3 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule pb-2 text-sm font-semibold tracking-[0.02em] text-ink">
                    <span className="font-mono text-2xs text-ink-3 tabular-nums">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="text-caps">{section.title}</span>
                    <span className="ml-auto font-mono text-2xs font-normal text-ink-3">
                      {section.code}
                    </span>
                  </h3>
                  <div className="mt-3 whitespace-pre-wrap text-ink">
                    {section.body ? (
                      section.body
                    ) : (
                      <span className="text-ink-3 italic">Empty section</span>
                    )}
                  </div>
                </article>
              ))
            )}
          </SheetBody>

          <SheetFooter>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-caps text-ink-3">Content hash</p>
                <HashText value={currentVersion?.documentHash} className="mt-1" blocks={3} />
              </div>
              <Rosette
                hash={currentVersion?.documentHash}
                size={56}
                className={isFinal ? 'text-seal' : 'text-ink-3'}
                decorative
              />
            </div>
          </SheetFooter>
        </Sheet>

        {/* Terms as a ruled schedule, not a card. */}
        {fields.length > 0 ? (
          <section className="mt-7" aria-labelledby="terms-title">
            <h3 id="terms-title" className="border-b border-rule-strong pb-2 font-serif text-lg text-ink">
              Schedule of terms
            </h3>
            <dl className="divide-y divide-rule">
              {fields.map((field) => (
                <div key={field.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3 text-sm">
                  <dt className="w-44 shrink-0 font-mono text-xs text-ink-3">{field.code}</dt>
                  <dd className="min-w-0 flex-1 text-ink">
                    {field.value === null || field.value === undefined || field.value === '' ? (
                      <span className="text-ink-3">—</span>
                    ) : typeof field.value === 'object' ? (
                      <span className="font-mono text-xs">{JSON.stringify(field.value)}</span>
                    ) : (
                      String(field.value)
                    )}
                  </dd>
                  {field.provenance === 'AI_SUGGESTED_CONFIRMED' ? (
                    <dd className="text-caps text-attention">Suggested · confirmed</dd>
                  ) : null}
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {sections.some((s) => !s.included) ? (
          <section className="mt-7 border-t border-rule pt-4">
            <p className="text-caps text-ink-3">Excluded from the instrument</p>
            <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
              {sections
                .filter((s) => !s.included)
                .map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <span aria-hidden className="inline-block h-px w-3 bg-ink-3" />
                    {s.title}
                  </li>
                ))}
            </ul>
          </section>
        ) : null}
      </div>

      {/* Marginalia rail */}
      <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start">
        <div className="flex flex-wrap gap-2">
          {currentVersion ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={<Eye className="h-3.5 w-3.5" />}
                onClick={() => void openPreview()}
              >
                Preview
              </Button>
              <a href={pdfUrl}>
                <Button variant="secondary" size="sm" icon={<Download className="h-3.5 w-3.5" />}>
                  PDF
                </Button>
              </a>
              <a href={`${base}/download`}>
                <Button variant="ghost" size="sm">
                  HTML
                </Button>
              </a>
            </>
          ) : null}
        </div>

        <Marginalia label="The record">
          {currentVersion
            ? `Version ${currentVersion.versionNumber}, committed ${formatDate(currentVersion.createdAt)}.`
            : 'No version has been committed yet.'}
        </Marginalia>

        <Marginalia label="Signatures">
          {parties.filter((p) => p.role === 'SIGNER').length} signer
          {parties.filter((p) => p.role === 'SIGNER').length === 1 ? '' : 's'} named.
          {currentVersion?.status === 'FINAL'
            ? ' Signatures are bound to this version hash.'
            : ' Signatures collect on the final version.'}
        </Marginalia>

        <Marginalia label="Integrity" tone="seal">
          Every version is snapshot-hashed. Any change after signing changes the hash and fails
          public verification.
        </Marginalia>
      </aside>

      {/* Preview modal: the exact bytes the PDF pipeline renders. */}
      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={`${agreement.publicId} · v${versionNo}`}
        description={
          isFinal
            ? 'Sealed document. The PDF is generated from exactly this content.'
            : 'This is exactly what will be in the PDF.'
        }
        size="lg"
        panelClassName="relative z-10 flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-none border border-rule bg-paper outline-none"
        titleClassName="font-serif text-lg text-ink"
        bodyClassName="flex-1 overflow-hidden bg-paper p-3 sm:p-5"
        footerClassName="flex flex-wrap justify-end gap-2 border-t border-rule bg-paper px-5 py-3"
        backdropClassName="absolute inset-0 bg-ink/30"
        footer={
          <>
            <Button
              variant="secondary"
              icon={<Printer className="h-4 w-4" />}
              onClick={() => iframeRef.current?.contentWindow?.print()}
            >
              Print
            </Button>
            <a href={pdfUrl}>
              <Button variant="secondary" icon={<Download className="h-4 w-4" />}>
                Download PDF
              </Button>
            </a>
            <Button onClick={() => setPreviewOpen(false)}>Close</Button>
          </>
        }
      >
        {previewLoading ? (
          <div className="flex h-[65vh] items-center justify-center text-sm text-ink-2">
            Rendering document…
          </div>
        ) : previewError ? (
          <div
            role="alert"
            className="flex h-[65vh] items-center justify-center px-6 text-center text-sm text-danger"
          >
            {previewError}
          </div>
        ) : previewHtml ? (
          <div
            ref={previewViewportRef}
            className="flex h-[70vh] w-full justify-center overflow-auto bg-paper sm:h-[72vh]"
          >
            <div
              style={{
                width: 820 * previewScale,
                height: '100%',
                flex: '0 0 auto',
              }}
            >
              <iframe
                ref={iframeRef}
                title={`Document preview for ${agreement.publicId}`}
                srcDoc={previewHtml}
                className="block border border-rule bg-paper"
                style={{
                  width: 820,
                  height: `${100 / previewScale}%`,
                  transform: `scale(${previewScale})`,
                  transformOrigin: 'top left',
                  minWidth: 0,
                }}
              />
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
