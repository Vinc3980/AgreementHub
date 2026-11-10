/**
 * Shared currency definitions for AgreementHub.
 *
 * Single source of truth for template currency options, validation, UI
 * formatting and document rendering. Do not duplicate this list elsewhere.
 *
 * Sort order is intentional: GHS first (primary market), then major
 * currencies used by templates, then others.
 */

export interface CurrencyDef {
  /** ISO 4217-style code used in stored values and documents (unambiguous). */
  code: string;
  /** Display name. */
  name: string;
  /** Symbol for web UI only (₵ for GHS). May be absent/unsafe in some fonts;
   *  prefer `code` in documents and monospace contexts. */
  symbol: string;
  /** Minor-unit fraction digits (2 for cedis/pesewas, dollars/cents, etc.). */
  minorUnits: number;
  /** Minor-unit name (e.g. "pesewas", "cents"). */
  minorName: string;
  /** Singular major-unit name (e.g. "Ghana Cedi"). */
  majorName: string;
  sortOrder: number;
}

/** Canonical currency list. GHS first; used by template options and the UI. */
export const CURRENCIES: readonly CurrencyDef[] = Object.freeze([
  { code: 'GHS', name: 'Ghana Cedi', symbol: 'GH₵', minorUnits: 2, minorName: 'pesewas', majorName: 'Ghana Cedi', sortOrder: 1 },
  { code: 'USD', name: 'US Dollar', symbol: '$', minorUnits: 2, minorName: 'cents', majorName: 'US Dollar', sortOrder: 2 },
  { code: 'GBP', name: 'British Pound', symbol: '£', minorUnits: 2, minorName: 'pence', majorName: 'British Pound', sortOrder: 3 },
  { code: 'EUR', name: 'Euro', symbol: '€', minorUnits: 2, minorName: 'cents', majorName: 'Euro', sortOrder: 4 },
  { code: 'NGN', name: 'Nigerian Naira', symbol: '₦', minorUnits: 2, minorName: 'kobo', majorName: 'Nigerian Naira', sortOrder: 5 },
  { code: 'XOF', name: 'West African CFA Franc', symbol: 'CFA', minorUnits: 0, minorName: '', majorName: 'CFA Franc', sortOrder: 6 },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', minorUnits: 2, minorName: 'cents', majorName: 'Canadian Dollar', sortOrder: 7 },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', minorUnits: 2, minorName: 'cents', majorName: 'Australian Dollar', sortOrder: 8 },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', minorUnits: 2, minorName: 'paise', majorName: 'Indian Rupee', sortOrder: 9 },
]);

export const CURRENCY_CODES = CURRENCIES.map((c) => c.code);

const CURRENCY_BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

export function getCurrency(code: string | null | undefined): CurrencyDef | undefined {
  if (!code) return undefined;
  return CURRENCY_BY_CODE.get(String(code).trim().toUpperCase());
}

/** Template select options: ISO codes in sort order. */
export function currencyOptionCodes(): string[] {
  return [...CURRENCY_CODES];
}

/* --------------------------- amount parsing ---------------------------- */

/**
 * Parse a money amount from user input. Accepts grouped numbers, decimals,
 * and pasted values containing a currency symbol/code (e.g. "GH₵5,000",
 * "GHS 3500.50"). Returns a finite number or null if not parseable.
 */
export function parseMoneyAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (s === '') return null;
  // Strip known currency symbols/codes and whitespace/grouping noise.
  s = s
    .replace(/GH₵|GH¢|GHC|GHS|USD|GBP|EUR|NGN|XOF|CAD|AUD|INR/gi, '')
    .replace(/[₵¢$£€₦₹\s,]/g, '');
  if (s === '' || s === '-' || s === '+') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** True when the value has at most `decimals` fractional digits. */
export function hasMaxDecimals(value: number, decimals: number): boolean {
  if (!Number.isFinite(value)) return false;
  const factor = 10 ** decimals;
  return Math.abs(Math.round(value * factor) - value * factor) < 1e-9;
}

/** Validate a money field value (engine-level). Returns an error message or null. */
export function validateMoneyValue(raw: unknown, maxDecimals = 2): string | null {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return null; // blank handled by required check
  }
  const n = parseMoneyAmount(raw);
  if (n === null) return 'must be a number';
  if (n < 0) return 'must not be negative';
  if (!hasMaxDecimals(n, maxDecimals)) {
    return `must have no more than ${maxDecimals} decimal place${maxDecimals === 1 ? '' : 's'}`;
  }
  return null;
}

/** Canonical stored/normalized money string (no grouping, up to minor units). */
export function normalizeMoneyString(raw: unknown, minorUnits = 2): string | null {
  const n = parseMoneyAmount(raw);
  if (n === null) return null;
  if (minorUnits <= 0) return String(Math.round(n));
  // Avoid floating noise: work in minor units for typical 2-decimal currencies.
  const factor = 10 ** minorUnits;
  const rounded = Math.round(n * factor) / factor;
  // Trim trailing zeros but keep at least integer part; don't force .00 in storage.
  const fixed = rounded.toFixed(minorUnits);
  return fixed.replace(/\.?0+$/, '') || '0';
}

/* --------------------------- formatting -------------------------------- */

/**
 * Format for documents/PDFs: always ISO code, always grouped, fixed minor
 * units. Unambiguous and renders in every font. e.g. "GHS 5,000.00".
 */
export function formatMoneyDocument(amount: number, currencyCode: string): string {
  const def = getCurrency(currencyCode);
  const minor = def?.minorUnits ?? 2;
  const code = def?.code ?? (String(currencyCode || '').toUpperCase() || '???');
  const n = Number.isFinite(amount) ? amount : 0;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: minor,
    maximumFractionDigits: minor,
    useGrouping: true,
  }).format(n);
  return `${code} ${formatted}`;
}

/**
 * Format for the web UI. Uses en-GH locale with currency style when available,
 * with a safe fallback if the runtime lacks en-GH/ICU data. The ₵ symbol is
 * for web UI only; callers that render in fonts lacking U+20B5 (e.g. some
 * monospace contexts) should fall back to showing the ISO code instead.
 */
export function formatMoney(amount: number, currencyCode: string): string {
  const def = getCurrency(currencyCode);
  const code = def?.code ?? (String(currencyCode || '').toUpperCase() || '???');
  const n = Number.isFinite(amount) ? amount : 0;
  const minor = def?.minorUnits ?? 2;
  try {
    return new Intl.NumberFormat('en-GH', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: minor,
      maximumFractionDigits: minor,
    }).format(n);
  } catch {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: code,
        minimumFractionDigits: minor,
        maximumFractionDigits: minor,
      }).format(n);
    } catch {
      return formatMoneyDocument(n, code);
    }
  }
}

/* -------------------------- amount in words ---------------------------- */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const TEENS = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];

function intToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  n = Math.floor(n);
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  let scale = 0;
  while (n > 0 && scale < SCALES.length) {
    const chunk = n % 1000;
    if (chunk !== 0) {
      const words: string[] = [];
      const h = Math.floor(chunk / 100);
      const rem = chunk % 100;
      if (h) words.push(`${ONES[h]} Hundred`);
      if (rem >= 10 && rem < 20) words.push(TEENS[rem - 10]!);
      else {
        if (rem >= 20) words.push(TENS[Math.floor(rem / 10)]!);
        if (rem % 10) words.push(ONES[rem % 10]!);
      }
      const label = SCALES[scale];
      parts.unshift(words.join(' ') + (label ? ` ${label}` : ''));
    }
    n = Math.floor(n / 1000);
    scale += 1;
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function capitalize(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function pluralizeUnit(word: string, count: number): string {
  if (count === 1) return word.replace(/s$/i, (m) => (m ? '' : m));
  if (/s$/i.test(word)) return word;
  return `${word}s`;
}

/**
 * Legal-clarity amount in words.
 * e.g. `GHS 5,000.50 (Five Thousand Ghana Cedis and Fifty Pesewas)`.
 * Handles zero, minor-units only, large numbers, rounding. Falls back to
 * `CODE amount (Currency Name)` for unknown currencies.
 */
export function amountInWords(amount: number, currencyCode: string): string {
  const def = getCurrency(currencyCode);
  const code = def?.code ?? (String(currencyCode || '').toUpperCase() || '???');
  const minor = def?.minorUnits ?? 2;
  const n = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  const formatted = formatMoneyDocument(n, code);

  if (!def) {
    return `${formatted} (${code})`;
  }

  const factor = 10 ** minor;
  // Round half up to currency precision (avoid 10.005*100 floating-point issues).
  const totalMinor = Math.round(n * factor + 1e-8);
  const major = Math.floor(totalMinor / factor);
  const minorPart = totalMinor % factor;

  const majorName = major === 1 ? def.majorName : pluralizeUnit(def.majorName, major);
  const minorLabel = (count: number): string => {
    const base = count === 1 ? def.minorName.replace(/s$/i, '') : pluralizeUnit(def.minorName, count);
    return capitalize(base);
  };
  let words: string;
  if (totalMinor === 0) {
    words = `Zero ${pluralizeUnit(def.majorName, 0)}`;
  } else if (major === 0 && minor > 0 && def.minorName) {
    words = `${intToWords(minorPart)} ${minorLabel(minorPart)}`;
  } else if (minorPart > 0 && def.minorName) {
    words = `${intToWords(major)} ${majorName} and ${intToWords(minorPart)} ${minorLabel(minorPart)}`;
  } else {
    words = `${intToWords(major)} ${majorName}`;
  }

  return `${formatted} (${words})`;
}

/* ---------------------- Ghana phone validation ------------------------- */

/**
 * Validate/normalize Ghana phone numbers (used for mobile money fields).
 * Accepts local (0XXXXXXXXX) and international (+233/233) forms with common
 * spacing/dash grouping. Returns the normalized local 10-digit form
 * (0XXXXXXXXX) or null if invalid.
 */
export function normalizeGhanaPhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (s === '') return null;
  // Strip spaces, dashes, parentheses, dots.
  s = s.replace(/[\s\-().]/g, '');
  // Allow +233 / 233 prefix.
  if (s.startsWith('+233')) s = '0' + s.slice(4);
  else if (s.startsWith('233')) s = '0' + s.slice(3);
  // Must be 10 digits starting with 0.
  if (!/^0\d{9}$/.test(s)) return null;
  return s;
}

export function isValidGhanaPhone(raw: unknown): boolean {
  return normalizeGhanaPhone(raw) !== null;
}
