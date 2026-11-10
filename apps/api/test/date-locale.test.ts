import { describe, expect, it } from 'vitest';
import { renderDocumentHtml } from '../src/services/render.js';

const base = {
  publicId: 'AGR-GH-2026-000001',
  versionNumber: 1,
  versionStatus: 'FINAL',
  documentHash: 'a'.repeat(64),
  parties: [],
  templateName: 'Test',
  categoryName: 'Test',
  verificationUrl: 'https://example.test/verify/AGR-GH-2026-000001',
  createdAt: new Date('2026-11-09T12:00:00Z'),
  finalizedAt: new Date('2026-12-31T10:30:00Z'),
  signatures: [],
  content: {
    agreementPublicId: 'AGR-GH-2026-000001',
    title: 'Test Agreement',
    templateCode: 'TEST',
    sections: [{ code: 's', title: 'Section', body: 'Body', included: true }],
    fields: [
      { code: 'amount', value: '3500', provenance: 'USER_PROVIDED' },
      { code: 'currency', value: 'GHS', provenance: 'USER_PROVIDED' },
    ],
    parties: [],
  },
} as const;

describe('date formatting and document rendering (en-GH / Africa/Accra)', () => {
  it('renders document dates in unambiguous day-month-year order', async () => {
    const html = await renderDocumentHtml(base as any);
    expect(html).toContain('9 November 2026');
    expect(html).toContain('31 December 2026');
  });

  it('renders money with code+amount and amount-in-words beneath in key terms', async () => {
    const html = await renderDocumentHtml(base as any);
    expect(html).toContain('GHS 3,500.00');
    expect(html).toContain('Three Thousand Five Hundred Ghana Cedis');
    expect(html).toContain('money-words');
  });

  it('renders seal block with hash label and verification caption when final', async () => {
    const html = await renderDocumentHtml(base as any);
    expect(html).toContain('Document hash (SHA-256)');
    expect(html).toContain('Sealed 31 December 2026');
    expect(html).toContain('GMT');
    expect(html).toContain("This pattern is generated from the document&#39;s fingerprint. It matches the pattern on the verification page. If the text changes, the pattern changes.");
  });
});
