/**
 * Country, region, phone, and place data/helpers.
 *
 * Ghana-first: default country GH, +233 calling code, 16 administrative regions,
 * Ghana Post GPS digital addresses. Uses `libphonenumber-js/min` metadata for
 * international phone parsing/validation/formatting (keeps bundle smaller than
 * full metadata; impact is limited to this lib's min metadata + core).
 */
import {
  getCountries as getPhoneCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min';

/* ------------------------------------------------------------------ */
/* Countries (ISO 3166-1 alpha-2)                                      */
/* ------------------------------------------------------------------ */

export interface CountryDef {
  code: string; // ISO 3166-1 alpha-2
  name: string;
}

const NEIGHBOURS: string[] = ['CI', 'TG', 'BF', 'NG']; // Côte d'Ivoire, Togo, Burkina Faso, Nigeria

function buildCountryName(code: string): string {
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    return dn.of(code) ?? code;
  } catch {
    return code;
  }
}

function allIsoAlpha2Codes(): string[] {
  // A-Z A-Z combinations; filter to those Intl.DisplayNames recognizes as regions.
  const codes: string[] = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      codes.push(String.fromCharCode(a, b));
    }
  }
  const dn = (() => {
    try {
      return new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      return null;
    }
  })();
  if (!dn) return ['GH', ...NEIGHBOURS];
  return codes.filter((c) => {
    try {
      const name = dn.of(c);
      return !!name && name !== c && !/^[A-Z]{2}$/.test(name);
    } catch {
      return false;
    }
  });
}

let _countries: CountryDef[] | null = null;

export function getCountries(): CountryDef[] {
  if (_countries) return _countries;
  const all = allIsoAlpha2Codes();
  const byCode = new Map(all.map((c) => [c, { code: c, name: buildCountryName(c) }]));
  const ordered: CountryDef[] = [];
  const push = (code: string) => {
    const def = byCode.get(code);
    if (def) {
      ordered.push(def);
      byCode.delete(code);
    }
  };
  push('GH');
  for (const n of NEIGHBOURS) push(n);
  const rest = Array.from(byCode.values()).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  _countries = [...ordered, ...rest];
  return _countries;
}

export const COUNTRIES: CountryDef[] = getCountries();

export function isValidCountryCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const c = String(code).trim().toUpperCase();
  return COUNTRIES.some((x) => x.code === c);
}

export function normalizeCountryCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  return isValidCountryCode(c) ? c : null;
}

/** Best-effort backfill from legacy free-text country values. */
export function countryCodeFromLegacyText(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (up === 'GH' || up === 'GHA') return 'GH';
  if (/^ghana$/i.test(s)) return 'GH';
  // Try exact 2-letter code
  if (/^[A-Za-z]{2}$/.test(s) && isValidCountryCode(up)) return up;
  // Try matching by English name (case-insensitive)
  const found = COUNTRIES.find((c) => c.name.toLowerCase() === s.toLowerCase());
  return found ? found.code : null;
}

/* ------------------------------------------------------------------ */
/* Ghana regions (16)                                                  */
/* ------------------------------------------------------------------ */

export const GH_REGIONS = [
  'Ahafo',
  'Ashanti',
  'Bono',
  'Bono East',
  'Central',
  'Eastern',
  'Greater Accra',
  'North East',
  'Northern',
  'Oti',
  'Savannah',
  'Upper East',
  'Upper West',
  'Volta',
  'Western',
  'Western North',
] as const;

export type GhRegion = (typeof GH_REGIONS)[number];

export function isValidGhRegion(region: string | null | undefined): boolean {
  if (!region) return false;
  const s = String(region).trim();
  return (GH_REGIONS as readonly string[]).includes(s);
}

export function normalizeGhRegion(region: string | null | undefined): string | null {
  if (region == null) return null;
  const s = String(region).trim();
  if (!s) return null;
  return isValidGhRegion(s) ? s : null;
}

/* ------------------------------------------------------------------ */
/* Ghana Post GPS digital address                                      */
/* ------------------------------------------------------------------ */

export const GHANA_POST_GPS_RE = /^[A-Z]{2,3}-\d{3,4}-\d{4}$/;

export function normalizeGhanaPostGps(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  return GHANA_POST_GPS_RE.test(s) ? s : null;
}

export function isValidGhanaPostGps(raw: unknown): boolean {
  return normalizeGhanaPostGps(raw) !== null;
}

/* ------------------------------------------------------------------ */
/* Phone normalization (E.164)                                         */
/* ------------------------------------------------------------------ */

export interface PhoneNormalizeResult {
  e164: string;
  national: string;
  countryCode: string;
}

/**
 * Normalize a phone number to E.164. Defaults to Ghana (+233) when no country
 * calling code is provided, accepting local Ghana forms like 0241234567,
 * 024 123 4567, +233 24 123 4567. When `defaultCountry` is provided (ISO alpha-2),
 * numbers without an international prefix are interpreted in that country.
 * Returns null if invalid/unparseable.
 */
export function normalizePhoneToE164(
  raw: unknown,
  defaultCountry: string = 'GH',
): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Normalize common spacing/dash chars but keep leading +
  s = s.replace(/[\s\-().\u00A0]/g, '');
  if (!s) return null;
  const def = (String(defaultCountry || 'GH').trim().toUpperCase() || 'GH') as CountryCode;
  try {
    const pn = parsePhoneNumberFromString(s, def);
    if (!pn || !pn.isValid()) return null;
    return pn.number; // E.164
  } catch {
    return null;
  }
}

export function formatPhoneNational(raw: unknown, defaultCountry: string = 'GH'): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const def = (String(defaultCountry || 'GH').trim().toUpperCase() || 'GH') as CountryCode;
  try {
    const pn = parsePhoneNumberFromString(s.replace(/[\s\-().\u00A0]/g, ''), def);
    if (!pn || !pn.isValid()) return null;
    return pn.formatNational();
  } catch {
    return null;
  }
}

export function parsePhoneInfo(
  raw: unknown,
  defaultCountry: string = 'GH',
): PhoneNormalizeResult | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const def = (String(defaultCountry || 'GH').trim().toUpperCase() || 'GH') as CountryCode;
  try {
    const pn = parsePhoneNumberFromString(s.replace(/[\s\-().\u00A0]/g, ''), def);
    if (!pn || !pn.isValid()) return null;
    return { e164: pn.number, national: pn.formatNational(), countryCode: pn.country ?? def };
  } catch {
    return null;
  }
}

/** Ghana mobile-money/template helper (kept for compatibility): accepts GH forms, returns E.164 (+233...). */
export function normalizeGhanaPhoneE164(raw: unknown): string | null {
  return normalizePhoneToE164(raw, 'GH');
}

/** Country calling codes for a selector (country + dial code + name). Ghana/neighbours first. */
export function getCallingCodes(): Array<{ country: string; name: string; dial: string }> {
  try {
    const codes = getPhoneCountries();
    const list = codes.map((c) => ({
      country: c,
      name: buildCountryName(c),
      dial: `+${getCountryCallingCode(c)}`,
    }));
    list.sort((a, b) => {
      if (a.country === 'GH') return -1;
      if (b.country === 'GH') return 1;
      const aN = NEIGHBOURS.indexOf(a.country);
      const bN = NEIGHBOURS.indexOf(b.country);
      if (aN >= 0 || bN >= 0) return (aN < 0 ? 999 : aN) - (bN < 0 ? 999 : bN);
      return a.name.localeCompare(b.name, 'en');
    });
    return list;
  } catch {
    return [{ country: 'GH', name: 'Ghana', dial: '+233' }];
  }
}
