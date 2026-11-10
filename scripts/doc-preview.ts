import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';
import { loadConfig } from '../apps/api/src/config.js';
import { renderPdf } from '../apps/api/src/services/pdf.js';
import { renderDocumentHtml } from '../apps/api/src/services/render.js';

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function sampleInputs() {
  const hash = 'b7e1c9d4'.repeat(8);
  const verificationUrl = 'https://example.test/verify/AGR-GH-2026-000020';
  const longClause = [
    'The Consultant shall provide professional advisory services with due skill, care, and diligence, consistent with generally accepted industry standards applicable to the engagement.',
    'Services include discovery workshops, stakeholder interviews, written recommendations, implementation guidance, and periodic progress reviews as reasonably requested by the Client.',
    'Each deliverable shall be prepared in a clear and professional manner, delivered within agreed timelines, and revised in good faith where feedback is specific and provided within a reasonable review period.',
    'The parties acknowledge that timelines may be affected by the availability of information, timely approvals, and access to relevant personnel or systems; any resulting impact on schedule shall be communicated promptly and managed collaboratively.',
    'Confidential information exchanged in connection with this agreement shall be used solely for purposes of the engagement, protected with reasonable care, and not disclosed to third parties except as required by law or with prior written consent.',
    'Nothing in this clause limits either party’s statutory rights, and no provision shall be interpreted to waive liability that cannot lawfully be excluded.',
  ].join(' ');

  const base: any = {
    publicId: 'AGR-GH-2026-000020',
    versionNumber: 1,
    templateName: 'Consulting services agreement',
    categoryName: 'Professional services',
    verificationUrl,
    documentHash: hash,
    createdAt: new Date('2026-11-01T09:00:00Z'),
    finalizedAt: null,
    parties: [
      { email: 'ama.provider@example.com', displayName: 'Ama Mensah', role: 'OWNER', signingOrder: 0 },
      { email: 'kojo.client@example.com', displayName: 'Kojo Asante', role: 'SIGNER', signingOrder: 1 },
    ],
    fieldLabels: {
      service_fee: 'Service fee',
      currency: 'Currency',
      payment_schedule: 'Payment schedule',
      commencement_date: 'Commencement date',
    },
    content: {
      agreementPublicId: 'AGR-GH-2026-000020',
      title: 'Consulting Services Agreement',
      templateCode: 'CONSULTING',
      sections: [
        { code: 'scope', title: 'Scope of services', body: longClause, included: true },
        {
          code: 'fees',
          title: 'Fees and payment',
          body:
            'The Client shall pay the agreed service fee in accordance with the payment schedule. Amounts are stated in Ghana Cedis (GHS) unless otherwise specified in writing.\n\nLate payments may attract reasonable administrative follow-up and agreed remedial steps, without prejudice to either party’s rights.',
          included: true,
        },
        {
          code: 'term',
          title: 'Term and termination',
          body:
            'This agreement commences on the stated commencement date and continues until the services are completed, unless terminated earlier in accordance with its terms.\n\nEither party may terminate for material breach if the breach remains uncured after written notice and a reasonable opportunity to remedy.',
          included: true,
        },
      ],
      fields: [
        { code: 'service_fee', value: '3500', provenance: 'USER_PROVIDED' },
        { code: 'currency', value: 'GHS', provenance: 'USER_PROVIDED' },
        { code: 'payment_schedule', value: 'Monthly in arrears', provenance: 'USER_PROVIDED' },
        { code: 'commencement_date', value: '9 November 2026', provenance: 'USER_PROVIDED' },
      ],
      parties: [],
    },
  };

  const draft = { ...base, versionStatus: 'DRAFT', signatures: [] };
  const final = {
    ...base,
    versionStatus: 'FINAL',
    finalizedAt: new Date('2026-11-09T14:02:00Z'),
    signatures: [
      {
        signerEmail: 'ama.provider@example.com',
        displayName: 'Ama Mensah',
        partyRole: 'OWNER',
        signedAt: new Date('2026-11-09T13:50:00Z'),
        method: 'DRAWN',
        signatureText: null,
        signatureImage: PNG_DATA_URL,
      },
      {
        signerEmail: 'kojo.client@example.com',
        displayName: 'Kojo Asante',
        partyRole: 'SIGNER',
        signedAt: new Date('2026-11-09T14:02:00Z'),
        method: 'TYPED',
        signatureText: 'Kojo Asante',
        signatureImage: null,
      },
    ],
  };
  return { draft, final };
}

async function findBrowser(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.PDF_BROWSER_PATH) candidates.push(process.env.PDF_BROWSER_PATH);
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'];
    candidates.push(
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      local ? `${local}\\Google\\Chrome\\Application\\chrome.exe` : '',
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }
  for (const c of candidates.filter(Boolean)) {
    try {
      await access(c);
      return c;
    } catch {}
  }
  return null;
}

async function renderPngPages(html: string, outDir: string, baseName: string): Promise<string[]> {
  const executablePath = await findBrowser();
  if (!executablePath) return [];
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const paths: string[] = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });
    await page.emulateMediaType('print');
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (u.startsWith('data:') || u.startsWith('about:')) void req.continue();
      else void req.abort();
    });
    await page.setContent(html, { waitUntil: 'load' });
    const full = (await page.screenshot({ fullPage: true })) as Buffer;
    const meta = await sharp(full).metadata();
    const width = meta.width ?? 794 * 2;
    const height = meta.height ?? 1123 * 2;
    const pageHeight = 1123 * 2; // A4 height at deviceScaleFactor 2
    const pages = Math.max(1, Math.ceil(height / pageHeight));
    for (let i = 0; i < pages; i++) {
      const top = i * pageHeight;
      const extractHeight = Math.min(pageHeight, height - top);
      if (extractHeight <= 0) break;
      const out = join(outDir, `${baseName}-page-${i + 1}.png`);
      await sharp(full)
        .extract({ left: 0, top, width, height: extractHeight })
        .png()
        .toFile(out);
      paths.push(out);
    }
  } finally {
    await browser.close();
  }
  return paths;
}

async function main() {
  const { draft, final } = sampleInputs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(tmpdir(), `agreementhub-doc-preview-${stamp}`);
  await mkdir(outDir, { recursive: true });

  const config = loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://unused' } as any);

  for (const [kind, input] of [
    ['draft', draft],
    ['final', final],
  ] as const) {
    const html = await renderDocumentHtml(input);
    const pdf = await renderPdf(config, {
      html,
      footerLeft: `${input.publicId} · v${input.versionNumber} · ${kind === 'final' ? 'Final' : 'Draft'} · SHA-256 ${input.documentHash.slice(0, 8)}…`,
    });
    const pdfPath = join(outDir, `${kind}.pdf`);
    await writeFile(pdfPath, pdf.bytes);
    console.log(`PDF (${kind}): ${pdfPath}`);
    const pngs = await renderPngPages(html, outDir, kind);
    for (const p of pngs) console.log(`PNG (${kind}): ${p}`);
    if (pngs.length === 0) console.log(`PNG (${kind}): skipped (no browser found)`);
  }

  console.log(`Output folder: ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
