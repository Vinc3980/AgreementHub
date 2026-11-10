/**
 * Embedded document fonts for the PDF/HTML renderer.
 *
 * Headless Chromium blocks network requests, so web fonts cannot be fetched.
 * We embed the same families the website uses as base64 data-URI @font-face
 * rules (Latin subset, woff2) read once at startup and cached.
 *
 * Families:
 * - Newsreader 400, 400 italic, 600 (document headings and body)
 * - Instrument Sans 400, 600 (labels, metadata, tables)
 * - JetBrains Mono 400 (IDs, hashes)
 * - Mrs Saint Delafield 400 (typed signatures; restrained script)
 *
 * If any file is missing/unreadable, we fall back gracefully, the document
 * still renders with serif/sans/monospace stacks.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

interface FontFace {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  /** package name and relative file path inside its files/ dir */
  pkg: string;
  file: string;
}

const FACES: FontFace[] = [
  { family: 'Newsreader', weight: 400, style: 'normal', pkg: '@fontsource/newsreader', file: 'newsreader-latin-400-normal.woff2' },
  { family: 'Newsreader', weight: 400, style: 'italic', pkg: '@fontsource/newsreader', file: 'newsreader-latin-400-italic.woff2' },
  { family: 'Newsreader', weight: 600, style: 'normal', pkg: '@fontsource/newsreader', file: 'newsreader-latin-600-normal.woff2' },
  { family: 'Instrument Sans', weight: 400, style: 'normal', pkg: '@fontsource/instrument-sans', file: 'instrument-sans-latin-400-normal.woff2' },
  { family: 'Instrument Sans', weight: 600, style: 'normal', pkg: '@fontsource/instrument-sans', file: 'instrument-sans-latin-600-normal.woff2' },
  { family: 'JetBrains Mono', weight: 400, style: 'normal', pkg: '@fontsource/jetbrains-mono', file: 'jetbrains-mono-latin-400-normal.woff2' },
  { family: 'Mrs Saint Delafield', weight: 400, style: 'normal', pkg: '@fontsource/mrs-saint-delafield', file: 'mrs-saint-delafield-latin-400-normal.woff2' },
];

let cachedCss: string | null = null;

function tryReadFont(pkg: string, file: string): Buffer | null {
  const candidates: string[] = [];
  try {
    // Resolve package.json then look in files/
    const pkgJson = require.resolve(`${pkg}/package.json`);
    candidates.push(join(dirname(pkgJson), 'files', file));
  } catch {
    // ignore
  }
  // Common hoisted locations relative to cwd
  candidates.push(join(process.cwd(), 'node_modules', pkg, 'files', file));
  candidates.push(join(process.cwd(), '..', '..', 'node_modules', pkg, 'files', file));

  for (const p of candidates) {
    try {
      return readFileSync(p);
    } catch {
      // try next
    }
  }
  return null;
}

function buildCss(): string {
  const rules: string[] = [];
  for (const face of FACES) {
    const buf = tryReadFont(face.pkg, face.file);
    if (!buf) continue;
    const b64 = buf.toString('base64');
    rules.push(
      `@font-face{font-family:'${face.family}';font-style:${face.style};font-weight:${face.weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}`,
    );
  }
  return rules.join('\n');
}

/** Cached @font-face CSS block (base64 data URIs). Safe to call repeatedly. */
export function documentFontsCss(): string {
  if (cachedCss == null) cachedCss = buildCss();
  return cachedCss;
}

/** For tests/diagnostics: whether all expected faces were embedded. */
export function documentFontsLoadedCount(): number {
  // Count by rebuilding logic check against cached css occurrences
  const css = documentFontsCss();
  return (css.match(/@font-face/g) || []).length;
}

export const DOCUMENT_FONT_FAMILIES = {
  serif: "'Newsreader', Georgia, 'Times New Roman', serif",
  sans: "'Instrument Sans', 'Helvetica Neue', sans-serif",
  mono: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
  signature: "'Mrs Saint Delafield', 'Segoe Script', 'Bradley Hand', cursive",
} as const;
