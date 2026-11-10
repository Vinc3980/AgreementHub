/**
 * Deterministic HTML rendering of an agreement version.
 *
 * Paper, ink, hairlines, serif. One renderer for preview/HTML/print/PDF.
 * Fonts embedded as data URIs; all assets inline (safe for headless Chromium
 * with network blocked). Drafts are clearly marked "DRAFT: NOT FINAL"; sealed
 * documents are "FINAL AGREEMENT" with a hash-derived rosette seal.
 */
import QRCode from 'qrcode';
import { amountInWords, parseMoneyAmount, rosetteSvg } from '@agreementhub/domain';
import type { VersionContent } from '@agreementhub/domain';
import { DOCUMENT_THEME } from './documentTheme.js';
import { DOCUMENT_FONT_FAMILIES, documentFontsCss } from './documentFonts.js';

export interface RenderSignature {
  signerEmail: string;
  displayName: string | null;
  partyRole: string;
  signedAt: Date;
  method: string;
  signatureText: string | null;
  /** Drawn signature image as a data URL (DRAWN method). */
  signatureImage: string | null;
}

/** A party on the document roster (live party table, not the snapshot). */
export interface RenderParty {
  email: string;
  displayName: string;
  role: string;
  signingOrder: number;
}

export interface RenderDocumentInput {
  publicId: string;
  versionNumber: number;
  versionStatus: string;
  documentHash: string;
  content: VersionContent;
  parties: RenderParty[];
  templateName: string | null;
  categoryName: string | null;
  verificationUrl: string;
  createdAt: Date | null;
  finalizedAt: Date | null;
  signatures: RenderSignature[];
  /** Field code → human label from the template definition (render-time). */
  fieldLabels?: Record<string, string>;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DEFAULT_LOCALE = 'en-GH';
const DEFAULT_TIMEZONE = 'Africa/Accra'; // GMT (UTC+0) year-round

let _resolvedLocale: string | null = null;
function renderLocale(): string {
  if (_resolvedLocale) return _resolvedLocale;
  for (const candidate of [DEFAULT_LOCALE, 'en-GB']) {
    try {
      new Intl.DateTimeFormat(candidate, { day: 'numeric', month: 'long', year: 'numeric' }).format(
        new Date('2026-01-01T00:00:00Z'),
      );
      _resolvedLocale = candidate;
      return candidate;
    } catch {
      /* try next */
    }
  }
  _resolvedLocale = 'en-GB';
  return _resolvedLocale;
}

function toDate(d: Date | string | null): Date | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Unambiguous day-month-year date (e.g. 9 November 2026). */
function formatDate(d: Date | string | null): string {
  const date = toDate(d);
  if (!date) return '—';
  try {
    return new Intl.DateTimeFormat(renderLocale(), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: DEFAULT_TIMEZONE,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  }
}

/** Date + time for signature/seal lines (e.g. 9 November 2026, 14:02 GMT). */
function formatDateTime(d: Date | string | null): string {
  const date = toDate(d);
  if (!date) return '—';
  try {
    const base = new Intl.DateTimeFormat(renderLocale(), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: DEFAULT_TIMEZONE,
      timeZoneName: 'short',
    }).format(date);
    // Normalise "UTC" to "GMT" for Africa/Accra display
    return base.replace(/\bUTC\b/g, 'GMT');
  } catch {
    return `${formatDate(date)} GMT`;
  }
}

const METHOD_LABELS: Record<string, string> = {
  TYPED: 'Typed name',
  DRAWN: 'Drawn signature',
  CONSENT: 'Explicit electronic acceptance',
  SESSION: 'Session signature',
  EMAIL_OTP: 'Email one-time passcode',
};

function methodLabel(method: string): string {
  return METHOD_LABELS[method] ?? method;
}

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Provider',
  SIGNER: 'Client',
  CONTRIBUTOR: 'Contributor',
  REVIEWER: 'Reviewer',
  OBSERVER: 'Observer',
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    DRAFT: 'Draft',
    SUPERSEDED: 'Superseded',
    SUBMITTED: 'Submitted',
    APPROVED: 'Approved',
    FINAL: 'Final',
  };
  return labels[status] ?? status.charAt(0) + status.slice(1).toLowerCase();
}

function humanizeCode(code: string): string {
  const s = code.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return code;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function signatureVisual(sig: RenderSignature | undefined): string {
  if (!sig) return '';
  if (sig.signatureImage) {
    return `<img src="${esc(sig.signatureImage)}" alt="Signature of ${esc(
      sig.displayName ?? sig.signerEmail,
    )}" class="sig-drawn">`;
  }
  if (sig.signatureText) {
    return `<span class="sig-typed">${esc(sig.signatureText)}</span>`;
  }
  return `<span class="sig-consent">Electronically accepted</span>`;
}

function hashGrouped(hash: string): string {
  const clean = (hash || '').replace(/[^0-9a-fA-F]/g, '');
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += 4) groups.push(clean.slice(i, i + 4));
  return groups
    .map((g, i) => {
      if (i === 0) {
        const head = esc(g.slice(0, 4));
        return `<span class="hash-head">${head}</span>`;
      }
      if (i === 1) {
        // first 8 chars total: group 0 + group 1, group 1 fully bold
        return `<span class="hash-head">${esc(g)}</span>`;
      }
      return esc(g);
    })
    .join(' ');
}

async function qrSvg(url: string, dark: string): Promise<string> {
  try {
    const svg = await QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 0,
      color: { dark, light: '#00000000' },
    });
    return svg.replace(/<\?xml[^?]*\?>\s*/i, '').trim();
  } catch {
    return '';
  }
}

interface MoneyDisplay {
  primary: string; // e.g. "GHS 3,500.00"
  words?: string;  // amount in words
}

function moneyDisplay(code: string, value: unknown, fields: Array<{ code: string; value: unknown }>): MoneyDisplay | null {
  const raw = value == null ? '' : String(value);
  const isMoneyCode = /(fee|amount|price|deposit|cost|charge|total|balance|wage|salary)/i.test(code)
    && !/months|days|years|limit|count|number|interval|revision|percent/i.test(code);
  if (!isMoneyCode) return null;
  const n = parseMoneyAmount(raw);
  if (n === null || raw.trim() === '') return null;
  const prefix = code.replace(/_(amount|fee|price|deposit|cost|charge|total|balance)$/i, '');
  const currencyField = fields.find((c) => c.code === `${prefix}_currency`)
    ?? fields.find((c) => c.code === 'currency')
    ?? fields.find((c) => /currency/i.test(c.code));
  const currency = currencyField && currencyField.value != null ? String(currencyField.value).trim() : '';
  if (!currency) return null;
  const full = amountInWords(n, currency); // "GHS 3,500.00 (Three Thousand...)"
  const m = full.match(/^([^(]+?)\s*\((.+)\)\s*$/);
  if (m) return { primary: m[1]!.trim(), words: m[2]!.trim() };
  return { primary: full };
}

export async function renderDocumentHtml(input: RenderDocumentInput): Promise<string> {
  const { content } = input;
  const isFinal = input.versionStatus === 'FINAL';
  const t = DOCUMENT_THEME;
  const fonts = DOCUMENT_FONT_FAMILIES;
  const fieldLabel = (code: string) => input.fieldLabels?.[code] ?? humanizeCode(code);

  const sectionsHtml = content.sections
    .filter((s) => s.included)
    .map(
      (s, index) => `
      <section class="clause">
        <h2><span class="num">${index + 1}.</span> ${esc(s.title)}</h2>
        <div class="body">${esc(s.body).replace(/\n/g, '<br>')}</div>
      </section>`,
    )
    .join('\n');

  const fieldValueHtml = (code: string, value: unknown): string => {
    if (typeof value === 'object' && value !== null) return esc(JSON.stringify(value));
    const money = moneyDisplay(code, value, content.fields);
    if (money) {
      return `<span class="money-primary">${esc(money.primary)}</span>` +
        (money.words ? `<span class="money-words">${esc(money.words)}</span>` : '');
    }
    const raw = value == null ? '' : String(value);
    return esc(raw);
  };

  const fieldsHtml = content.fields.length
    ? `<section class="block">
       <h2>Key terms</h2>
       <table class="ruled">
         <tbody>
           ${content.fields
             .map(
               (f) =>
                 `<tr><th scope="row">${esc(fieldLabel(f.code))}</th><td>${fieldValueHtml(f.code, f.value)}</td></tr>`,
             )
             .join('')}
         </tbody>
       </table>
       </section>`
    : '';

  const signatureByEmail = new Map(
    input.signatures.map((s) => [s.signerEmail.toLowerCase(), s]),
  );

  const partiesHtml = `<section class="block">
    <h2>Parties</h2>
    <table class="ruled">
      <thead><tr><th>Party</th><th>Email</th><th>Role</th><th>Order</th><th>Signed</th></tr></thead>
      <tbody>
        ${input.parties
          .map((p) => {
            const sig = signatureByEmail.get(p.email.toLowerCase());
            return `<tr><td>${esc(p.displayName || '—')}</td><td class="mono">${esc(p.email)}</td><td>${esc(
              roleLabel(p.role),
            )}</td><td class="num-cell">${esc(p.signingOrder)}</td><td>${
              sig ? esc(formatDate(sig.signedAt)) : '—'
            }</td></tr>`;
          })
          .join('')}
      </tbody>
    </table></section>`;

  const signingParties = input.parties.filter(
    (p) => p.role === 'OWNER' || p.role === 'SIGNER',
  );
  const signatureBlocks = signingParties
    .map((p) => {
      const sig = signatureByEmail.get(p.email.toLowerCase());
      const displayName = p.displayName || p.email;
      const signedLine = sig
        ? `Signed · ${esc(methodLabel(sig.method))} · ${esc(formatDateTime(sig.signedAt))}`
        : `<span class="awaiting"><span class="glyph" aria-hidden="true">○</span> Awaiting signature</span>`;
      return `
      <div class="sig-block">
        <div class="sig-role">${esc(roleLabel(p.role))}</div>
        <div class="sig-rows">
          <div class="sig-row"><span class="sig-label">Name</span><div class="sig-line">${esc(displayName)}</div></div>
          <div class="sig-row"><span class="sig-label">Signature</span><div class="sig-line sig-line-mark"><span class="xmark" aria-hidden="true">×</span><span class="sig-value">${signatureVisual(sig)}</span></div></div>
          <div class="sig-row"><span class="sig-label">Date</span><div class="sig-line">${sig ? esc(formatDate(sig.signedAt)) : ''}</div></div>
        </div>
        <div class="sig-meta">${signedLine}</div>
      </div>`;
    })
    .join('\n');

  const signaturesHtml = `<section class="signature-page block">
    <h2>Signatures</h2>
    <p class="sig-intro">By signing below, each party electronically accepts this agreement. The signing method, timestamp and the document hash at signing are recorded in the immutable audit trail.</p>
    <div class="sig-grid">${signatureBlocks || '<p class="sig-intro">No signing parties recorded.</p>'}</div>
  </section>`;

  // Header brand rosette (navy, with signature line)
  const brandMark = rosetteSvg({
    hash: 'agreementhub-instrument-v1',
    size: 37, // ~28pt
    color: t.navy,
    withSignature: true,
    decorative: true,
  });

  // Status stamp
  const statusStamp = isFinal
    ? `<span class="stamp stamp-final"><span class="glyph" aria-hidden="true">●</span> FINAL AGREEMENT</span>`
    : `<span class="stamp stamp-draft"><span class="glyph" aria-hidden="true">○</span> DRAFT: NOT FINAL</span>`;

  // Seal block
  let sealBlock: string;
  if (isFinal) {
    const sealRosette = rosetteSvg({
      hash: input.documentHash,
      size: 120, // ~90pt
      color: t.seal,
      decorative: false,
      label: `Document seal rosette derived from fingerprint ${input.documentHash.slice(0, 8)}`,
    });
    const qr = await qrSvg(input.verificationUrl, t.ink);
    sealBlock = `
    <section class="seal-block">
      <div class="seal-row">
        <div class="seal-mark">${sealRosette}</div>
        <div class="seal-info">
          <div class="sealed-line">Sealed ${esc(formatDateTime(input.finalizedAt))}</div>
          <div class="hash-label">Document hash (SHA-256)</div>
          <div class="hash-value">${hashGrouped(input.documentHash)}</div>
          <div class="verify-line">Verify: <a href="${esc(input.verificationUrl)}">${esc(input.verificationUrl)}</a></div>
        </div>
        ${qr ? `<div class="seal-qr"><div class="qr-box">${qr}</div></div>` : ''}
      </div>
      <p class="seal-caption">This pattern is generated from the document&#39;s fingerprint. It matches the pattern on the verification page. If the text changes, the pattern changes.</p>
    </section>`;
  } else {
    sealBlock = `
    <section class="seal-block seal-draft">
      <div class="seal-row">
        <div class="seal-mark"><div class="draft-ring" aria-hidden="true"></div></div>
        <div class="seal-info">
          <div class="sealed-line muted">Not sealed yet</div>
          <div class="hash-label">Document hash (SHA-256)</div>
          <div class="hash-value muted">—</div>
        </div>
      </div>
    </section>`;
  }

  const watermark = isFinal ? '' : `<div class="watermark" aria-hidden="true">DRAFT: NOT FINAL</div>`;
  const fontCss = documentFontsCss();

  // Metadata rows (two-column ruled definition list)
  const metaRows: Array<[string, string]> = [
    ['Agreement ID', `<span class="mono">${esc(input.publicId)}</span>`],
    ['Version', `${esc(input.versionNumber)} · ${esc(statusLabel(input.versionStatus))}`],
    ['Category', esc(input.categoryName ?? '—')],
    ['Template', esc(input.templateName ?? '—')],
    ['Effective date', isFinal ? esc(formatDate(input.finalizedAt)) : 'Upon finalization (draft)'],
    ['Created', esc(formatDate(input.createdAt))],
  ];
  const metaHtml = metaRows
    .map(
      ([k, v]) =>
        `<div class="meta-row"><dt>${k}</dt><dd>${v}</dd></div>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.publicId)}, ${esc(content.title)}</title>
<style>
${fontCss}
  @page { size: A4; margin: 18mm 20mm 18mm; }
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    color: ${t.ink};
    background: ${t.paper}; /* on-screen backdrop around sheet */
    font-family: ${fonts.serif};
    font-size: 10.5pt;
    line-height: 1.55;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  @media screen {
    body { padding: 24px 14px 40px; background: ${t.paper}; }
    .doc {
      max-width: 820px;
      margin: 0 auto;
      background: ${t.sheet};
      padding: 18mm 20mm;
      border: 0.5pt solid ${t.rule};
    }
  }
  @media print {
    body { background: #fff; }
    .doc { background: #fff; padding: 0; border: none; }
  }

  .watermark { position: fixed; top: 50%; left: 50%; z-index: 0; pointer-events: none;
               transform: translate(-50%, -50%) rotate(-24deg); white-space: nowrap;
               font-family: ${fonts.serif}; font-size: 64pt; font-weight: 600; letter-spacing: .28em;
               text-transform: uppercase; color: ${t.ink}; opacity: 0.04; }
  .doc { position: relative; z-index: 1; }

  /* Header */
  .header { padding-bottom: 10pt; }
  .header-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16pt; }
  .brand { display: flex; align-items: center; gap: 10pt; }
  .brand svg { display: block; flex: 0 0 auto; }
  .wordmark { font-family: ${fonts.serif}; font-weight: 600; font-size: 14pt; letter-spacing: .06em; color: ${t.ink}; }
  .double-rule { margin-top: 10pt; border-top: 1pt solid ${t.ink}; height: 3pt; border-bottom: 0.5pt solid ${t.ink}; }

  .stamp { display: inline-flex; align-items: center; gap: 6pt; padding: 3pt 8pt; border: 1px solid;
           border-radius: 2px; font-family: ${fonts.sans}; font-size: 7pt; font-weight: 600;
           letter-spacing: .14em; text-transform: uppercase; font-variant-caps: all-small-caps;
           white-space: nowrap; line-height: 1.2; }
  .stamp .glyph { font-size: 7pt; line-height: 1; }
  .stamp-final { color: ${t.seal}; border-color: ${t.seal}; background: transparent; }
  .stamp-draft { color: ${t.attention}; border-color: ${t.attention}; background: ${t.attentionTint}; }

  /* Title */
  .title-block { margin-top: 18pt; }
  h1 { font-family: ${fonts.serif}; font-weight: 600; font-size: 26pt; line-height: 1.15; letter-spacing: -0.01em;
       color: ${t.ink}; margin: 0 0 6pt; }
  .doc-id { font-family: ${fonts.mono}; font-size: 9pt; color: ${t.ink3}; margin: 0 0 2pt; }
  .doc-version { font-family: ${fonts.sans}; font-size: 9pt; color: ${t.ink2}; margin: 0; }

  /* Metadata: ruled definition list, no boxes */
  .meta { margin: 16pt 0 6pt; border-top: 0.5pt solid ${t.ruleStrong}; }
  .meta-row { display: grid; grid-template-columns: 38% 1fr; gap: 10pt; padding: 6pt 0;
              border-bottom: 0.5pt solid ${t.rule}; break-inside: avoid; }
  .meta-row dt { margin: 0; font-family: ${fonts.sans}; font-size: 7.5pt; font-weight: 600; letter-spacing: .14em;
                 text-transform: uppercase; font-variant-caps: all-small-caps; color: ${t.ink3}; }
  .meta-row dd { margin: 0; font-family: ${fonts.sans}; font-size: 9.5pt; color: ${t.ink}; }

  /* Sections */
  h2 { font-family: ${fonts.serif}; font-weight: 600; font-size: 13pt; color: ${t.ink}; margin: 22pt 0 8pt;
       padding-bottom: 4pt; border-bottom: 0.5pt solid ${t.rule}; page-break-after: avoid; }
  .num { font-variant-numeric: tabular-nums; margin-right: 6pt; }
  .body { font-family: ${fonts.serif}; font-size: 10.5pt; line-height: 1.55; color: ${t.ink};
          text-align: left; hyphens: none; orphans: 3; widows: 3; }
  .clause { break-inside: avoid-page; }
  .block { break-inside: avoid; }

  /* Ruled tables (open, no vertical/outer borders) */
  table.ruled { width: 100%; border-collapse: collapse; font-family: ${fonts.sans}; font-size: 9.5pt; }
  table.ruled th, table.ruled td { padding: 7pt 4pt 7pt 0; text-align: left; vertical-align: top;
                                   border-bottom: 0.5pt solid ${t.rule}; }
  table.ruled thead th { font-size: 7.5pt; font-weight: 600; letter-spacing: .14em; text-transform: uppercase;
                         font-variant-caps: all-small-caps; color: ${t.ink3}; border-bottom: 0.5pt solid ${t.ruleStrong}; padding-bottom: 5pt; }
  table.ruled tbody th { font-weight: 500; color: ${t.ink2}; width: 36%; }
  table.ruled tbody td { color: ${t.ink}; }
  table.ruled tbody tr:last-child th, table.ruled tbody tr:last-child td { border-bottom: 0.5pt solid ${t.ruleStrong}; }
  .mono { font-family: ${fonts.mono}; font-size: 8.5pt; }
  .num-cell { font-variant-numeric: tabular-nums; }
  .money-primary { display: block; }
  .money-words { display: block; margin-top: 2pt; font-family: ${fonts.serif}; font-style: italic; color: ${t.ink2}; font-size: 9.5pt; }

  /* Signatures */
  .signature-page { page-break-before: always; }
  .sig-intro { font-family: ${fonts.sans}; font-size: 9pt; color: ${t.ink3}; margin: 0 0 14pt; }
  .sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 22pt 28pt; }
  .sig-block { break-inside: avoid; }
  .sig-role { font-family: ${fonts.sans}; font-size: 7.5pt; font-weight: 600; letter-spacing: .14em; text-transform: uppercase;
              font-variant-caps: all-small-caps; color: ${t.navy}; margin-bottom: 10pt; }
  .sig-rows { display: flex; flex-direction: column; gap: 10pt; }
  .sig-row { display: grid; grid-template-columns: 64pt 1fr; gap: 8pt; align-items: end; }
  .sig-label { font-family: ${fonts.sans}; font-size: 7.5pt; font-weight: 600; letter-spacing: .12em; text-transform: uppercase;
               font-variant-caps: all-small-caps; color: ${t.ink3}; padding-bottom: 3pt; }
  .sig-line { min-height: 22pt; border-bottom: 0.5pt solid ${t.ruleStrong}; display: flex; align-items: flex-end;
              padding: 0 0 3pt 0; font-family: ${fonts.sans}; font-size: 9.5pt; color: ${t.ink}; }
  .sig-line-mark { position: relative; padding-left: 12pt; }
  .xmark { position: absolute; left: 0; bottom: 1pt; font-family: ${fonts.sans}; font-size: 10pt; color: ${t.ink3}; line-height: 1; }
  .sig-value { display: flex; align-items: flex-end; min-height: 18pt; }
  .sig-drawn { display: block; max-height: 34pt; max-width: 100%; }
  .sig-typed { font-family: ${fonts.signature}; font-size: 26pt; line-height: 1; color: ${t.ink}; }
  .sig-consent { font-family: ${fonts.serif}; font-style: italic; font-size: 10pt; color: ${t.ink2}; }
  .sig-meta { margin-top: 8pt; font-family: ${fonts.sans}; font-size: 8pt; color: ${t.ink3}; }
  .sig-meta .awaiting { color: ${t.attention}; }
  .sig-meta .glyph { margin-right: 3pt; }

  /* Seal block */
  .seal-block { margin-top: 26pt; padding-top: 14pt; border-top: 0.5pt solid ${t.ruleStrong}; break-inside: avoid; }
  .seal-row { display: flex; gap: 18pt; align-items: flex-start; }
  .seal-mark { flex: 0 0 auto; }
  .seal-mark svg { display: block; }
  .draft-ring { width: 120px; height: 120px; border: 1px dashed ${t.ruleStrong}; border-radius: 50%; }
  .seal-info { flex: 1 1 auto; min-width: 0; }
  .sealed-line { font-family: ${fonts.sans}; font-size: 9.5pt; color: ${t.ink}; margin-bottom: 8pt; }
  .sealed-line.muted { color: ${t.ink3}; }
  .hash-label { font-family: ${fonts.sans}; font-size: 7.5pt; font-weight: 600; letter-spacing: .14em; text-transform: uppercase;
                font-variant-caps: all-small-caps; color: ${t.ink3}; margin-bottom: 3pt; }
  .hash-value { font-family: ${fonts.mono}; font-size: 8pt; color: ${t.ink2}; line-height: 1.6; word-break: break-all; }
  .hash-value.muted { color: ${t.ink3}; }
  .hash-head { font-weight: 600; color: ${t.ink}; }
  .verify-line { margin-top: 8pt; font-family: ${fonts.sans}; font-size: 8.5pt; color: ${t.ink3}; word-break: break-all; }
  .verify-line a { color: ${t.navy}; text-decoration: none; }
  .seal-qr { flex: 0 0 auto; }
  .qr-box { width: 28mm; height: 28mm; }
  .qr-box svg { width: 100%; height: 100%; display: block; }
  .seal-caption { margin: 10pt 0 0; font-family: ${fonts.sans}; font-size: 8pt; color: ${t.ink2}; max-width: 120mm; }

  @media print {
    .no-print { display: none !important; }
    a { color: ${t.navy}; text-decoration: none; }
  }
</style>
</head>
<body>
${watermark}
<div class="doc">
  <header class="header">
    <div class="header-top">
      <div class="brand">
        ${brandMark}
        <span class="wordmark">AgreementHub</span>
      </div>
      ${statusStamp}
    </div>
    <div class="double-rule" aria-hidden="true"></div>
  </header>

  <div class="title-block">
    <h1>${esc(content.title)}</h1>
    <p class="doc-id">${esc(input.publicId)}</p>
    <p class="doc-version">Version ${esc(input.versionNumber)} · ${esc(statusLabel(input.versionStatus))}</p>
  </div>

  <dl class="meta">
    ${metaHtml}
  </dl>

  ${sectionsHtml}
  ${fieldsHtml}
  ${partiesHtml}
  ${signaturesHtml}
  ${sealBlock}
</div>
</body>
</html>`;
}
