import { describe, expect, it } from 'vitest';
import { rosetteSvg } from '@agreementhub/domain';
import { DOCUMENT_THEME } from '../src/services/documentTheme.js';
import { renderDocumentHtml } from '../src/services/render.js';

const DOC_HASH = 'a1b2c3d4'.repeat(8); // 64 hex chars
const VERIFY_URL = 'https://example.test/verify/AGR-GH-2026-000020';

const baseParties = [
  { email: 'provider@example.com', displayName: 'Ama Provider', role: 'OWNER', signingOrder: 0 },
  { email: 'client@example.com', displayName: 'Kojo Client', role: 'SIGNER', signingOrder: 1 },
];

const draftInput: any = {
  publicId: 'AGR-GH-2026-000020',
  versionNumber: 1,
  versionStatus: 'DRAFT',
  documentHash: DOC_HASH,
  templateName: 'Service agreement',
  categoryName: 'Services',
  verificationUrl: VERIFY_URL,
  createdAt: new Date('2026-11-09T12:00:00Z'),
  finalizedAt: null,
  parties: baseParties,
  signatures: [],
  fieldLabels: {
    payment_schedule: 'Payment schedule',
    service_fee: 'Service fee',
    currency: 'Currency',
  },
  content: {
    agreementPublicId: 'AGR-GH-2026-000020',
    title: 'Consulting Services Agreement',
    templateCode: 'SVC',
    sections: [
      { code: 'scope', title: 'Scope of work', body: 'Provide consulting services.', included: true },
      { code: 'term', title: 'Term', body: 'This agreement runs for 12 months.', included: true },
    ],
    fields: [
      { code: 'payment_schedule', value: 'Monthly', provenance: 'USER_PROVIDED' },
      { code: 'service_fee', value: '3500', provenance: 'USER_PROVIDED' },
      { code: 'currency', value: 'GHS', provenance: 'USER_PROVIDED' },
    ],
    parties: [],
  },
};

const finalInput: any = {
  ...draftInput,
  versionStatus: 'FINAL',
  finalizedAt: new Date('2026-12-31T14:02:00Z'),
  signatures: [
    {
      signerEmail: 'provider@example.com',
      displayName: 'Ama Provider',
      partyRole: 'OWNER',
      signedAt: new Date('2026-12-31T13:50:00Z'),
      method: 'TYPED',
      signatureText: 'Ama Provider',
      signatureImage: null,
    },
    {
      signerEmail: 'client@example.com',
      displayName: 'Kojo Client',
      partyRole: 'SIGNER',
      signedAt: new Date('2026-12-31T14:00:00Z'),
      method: 'DRAWN',
      signatureText: null,
      signatureImage:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    },
  ],
};

describe('rendered agreement HTML (instrument identity)', () => {
  it('contains no legacy/app styling artifacts and uses embedded fonts only', async () => {
    const html = await renderDocumentHtml(draftInput);
    expect(html).not.toContain('#4338ca');
    expect(html).not.toContain('-apple-system');
    expect(html).not.toContain('Segoe UI');
    expect(html).not.toContain('Roboto');
    expect(html).not.toContain('Arial');

    // Embedded @font-face rules with data URIs for all families (7 faces).
    expect((html.match(/@font-face/g) || []).length).toBe(7);
    expect(html).toMatch(/@font-face[\s\S]*?src:url\(data:font\/woff2;base64,/);

    // No external network resources.
    expect(html).not.toMatch(/src="http/i);
    expect(html).not.toMatch(/url\(http/i);
    expect(html).not.toMatch(/<link\b[^>]*rel=["']stylesheet["']/i);
    expect(html).not.toMatch(/<script\b/i);
  });

  it('final: contains seal rosette with aria-label, QR, verification URL and grouped hash; matches rosetteSvg exactly', async () => {
    const html = await renderDocumentHtml(finalInput);
    expect(html).toContain('FINAL AGREEMENT');
    expect(html).toContain(VERIFY_URL);
    expect(html).toContain('Document hash (SHA-256)');
    expect(html).toContain('hash-head'); // grouped hash with first 8 chars emphasized
    expect(html).toContain('qr-box');

    const expectedSeal = rosetteSvg({
      hash: DOC_HASH,
      size: 120,
      color: DOCUMENT_THEME.seal,
      decorative: false,
      label: `Document seal rosette derived from fingerprint ${DOC_HASH.slice(0, 8)}`,
    });
    expect(html).toContain(expectedSeal);
    expect(expectedSeal).toContain('aria-label=');
    expect(expectedSeal).toContain('role="img"');

    // QR is an inline SVG (no external src).
    expect(html).toMatch(/<div class="qr-box"><svg[\s\S]*?<\/svg><\/div>/);
  });

  it('draft: contains "Not sealed yet" and no QR', async () => {
    const html = await renderDocumentHtml(draftInput);
    expect(html).toContain('DRAFT: NOT FINAL');
    expect(html).toContain('Not sealed yet');
    expect(html).not.toContain('<div class="seal-qr">');
    expect(html).not.toContain('<div class="qr-box">');
  });

  it('key terms show human labels and no raw snake_case codes in cells', async () => {
    const html = await renderDocumentHtml(draftInput);
    expect(html).toContain('Payment schedule');
    expect(html).toContain('Service fee');
    expect(html).toContain('Currency');
    // Raw codes must not appear as term labels/cell text.
    expect(html).not.toContain('>payment_schedule<');
    expect(html).not.toContain('>service_fee<');
    // No cell whose text is a raw snake_case code pattern.
    const cellTexts = [...html.matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, '').trim(),
    );
    const rawCode = /^[a-z]+(?:_[a-z0-9]+)+$/;
    const rawMatches = cellTexts.filter((t) => rawCode.test(t));
    expect(rawMatches).toEqual([]);
  });

  it('token parity test with globals.css exists (Phase O guard)', async () => {
    // Covered by apps/api/test/document-theme.test.ts; assert here for visibility.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const p = path.join(process.cwd(), 'apps', 'api', 'test', 'document-theme.test.ts');
    expect(fs.existsSync(p)).toBe(true);
  });
});
