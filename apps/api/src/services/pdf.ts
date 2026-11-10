/**
 * HTML → PDF rendering for the document-generation pipeline.
 *
 * Renders the exact HTML produced by `renderDocumentHtml` through a
 * headless Chromium-based browser (Chrome/Edge), with printer-friendly
 * page setup and a per-page footer carrying the Agreement ID, version and
 * page numbers. The browser executable is resolved once (PDF_BROWSER_PATH
 * or well-known install locations) and reused through a lazy singleton.
 *
 * Security posture:
 *  - the browser runs with an isolated temporary profile;
 *  - every network request from the rendered document is blocked (documents
 *    embed only inline `data:` images), so rendering can never fetch or
 *    leak anything to the internet;
 *  - nothing in this module exposes storage paths or URLs to clients.
 */
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import { AppError } from '@agreementhub/domain';
import type { Config } from '../config.js';

export interface PdfRenderResult {
  bytes: Buffer;
  /** Human-readable engine identification (browser version + renderer). */
  engine: string;
}

export interface PdfRenderInput {
  html: string;
  /** Left-hand footer text (Agreement ID · version · status). */
  footerLeft?: string;
}

/** Well-known browser locations per platform (first hit wins). */
async function candidateExecutables(config: Config): Promise<string[]> {
  const list: string[] = [];
  if (config.PDF_BROWSER_PATH) list.push(config.PDF_BROWSER_PATH);

  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'];
    list.push(
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      local ? `${local}\\Google\\Chrome\\Application\\chrome.exe` : '',
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }
  return list.filter(Boolean);
}

/** Resolve a usable browser executable, or null when none exists. */
async function findBrowserExecutable(config: Config): Promise<string | null> {
  for (const candidate of await candidateExecutables(config)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

let browserPromise: Promise<Browser> | null = null;
let profileDir: string | null = null;

function unavailable(detail: string): AppError {
  return new AppError(
    503,
    'PDF_UNAVAILABLE',
    'PDF generation is unavailable: no usable Chrome/Edge browser was found. ' +
      'Set PDF_BROWSER_PATH to a browser executable or disable PDF_GENERATION.',
    detail,
  );
}

async function launchBrowser(config: Config): Promise<Browser> {
  const executablePath = await findBrowserExecutable(config);
  if (!executablePath) throw unavailable('no browser executable found');

  // Isolated profile: never attaches to a user's running browser session.
  profileDir = await mkdtemp(join(tmpdir(), 'ah-pdf-'));
  try {
    return await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-background-networking',
        `--user-data-dir=${profileDir}`,
      ],
    });
  } catch (err) {
    profileDir = null;
    throw unavailable(err instanceof Error ? err.message : String(err));
  }
}

/** Lazy singleton browser; relaunches after a disconnect. */
async function getBrowser(config: Config): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser(config).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  let browser: Browser;
  try {
    browser = await browserPromise;
  } catch (err) {
    browserPromise = null;
    throw err;
  }
  if (!browser.connected) {
    browserPromise = null;
    return getBrowser(config);
  }
  return browser;
}

/** Close the shared browser and delete its temporary profile. */
export async function closePdfBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  const dir = profileDir;
  profileDir = null;
  if (pending) {
    try {
      const browser = await pending;
      await browser.close();
    } catch {
      // already gone
    }
  }
  if (dir) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Per-page footer injected by Chromium (page numbers + document identity).
 * Header/footer templates are isolated from page styles, so embedded document
 * fonts are unavailable here; use a plain serif system fallback (no Arial).
 */
function footerTemplate(footerLeft: string): string {
  return (
    `<div style="width:100%; font-family:Georgia,'Times New Roman',serif; font-size:7.5pt; color:#62656D;` +
    ` display:flex; justify-content:space-between; padding:0 20mm; letter-spacing:0.01em;">` +
    `<span>${escapeHtml(footerLeft)}</span>` +
    `<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>` +
    `</div>`
  );
}

/**
 * Render an HTML document to a PDF buffer (A4, print backgrounds, per-page
 * footer). Never persists anything, callers decide whether bytes go to
 * storage or are streamed out ephemerally.
 */
export async function renderPdf(config: Config, input: PdfRenderInput): Promise<PdfRenderResult> {
  const browser = await getBrowser(config);
  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(20_000);
    // Documents embed only inline data URLs: block every other request so
    // rendering cannot reach the network in either direction.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().startsWith('data:') || req.url().startsWith('about:')) {
        void req.continue();
      } else {
        void req.abort();
      }
    });
    await page.setContent(input.html, { waitUntil: 'load', timeout: 20_000 });
    const pdfOptions: any = {
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footerTemplate(input.footerLeft ?? ''),
      // Keep in sync with @page in render.ts (18mm top/sides 20mm/18mm bottom).
      // preferCSSPageSize lets the document's @page drive page size/margins.
      preferCSSPageSize: true,
      margin: { top: '18mm', bottom: '18mm', left: '20mm', right: '20mm' },
      // Keep text selectable. Enable tagged (accessible) PDF and outline/bookmarks
      // when supported by the installed puppeteer-core/Chromium.
      tagged: true,
      outline: true,
    };
    const pdf = await page.pdf(pdfOptions);
    return {
      bytes: Buffer.from(pdf),
      engine: `${await browser.version()} via puppeteer-core`,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unavailable(err instanceof Error ? err.message : String(err));
  } finally {
    await page.close().catch(() => undefined);
  }
}
