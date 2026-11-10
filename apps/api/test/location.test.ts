import { describe, expect, it } from 'vitest';
import {
  countryCodeFromLegacyText,
  COUNTRIES,
  GH_REGIONS,
  isValidGhanaPostGps,
  normalizeGhanaPostGps,
  normalizePhoneToE164,
} from '@agreementhub/domain/location';

describe('location data', () => {
  it('lists Ghana first, then West African neighbours, in COUNTRIES', () => {
    expect(COUNTRIES[0]).toMatchObject({ code: 'GH', name: 'Ghana' });
    const codes = COUNTRIES.map((c) => c.code);
    const gh = codes.indexOf('GH');
    const ci = codes.indexOf('CI');
    const tg = codes.indexOf('TG');
    const bf = codes.indexOf('BF');
    const ng = codes.indexOf('NG');
    expect([gh, ci, tg, bf, ng]).toEqual([0, 1, 2, 3, 4]);
  });

  it('includes the 16 regions of Ghana', () => {
    expect(GH_REGIONS).toHaveLength(16);
    expect(GH_REGIONS).toContain('Greater Accra');
    expect(GH_REGIONS).toContain('Ashanti');
    expect(GH_REGIONS).toContain('Western North');
  });
});

describe('country backfill helper (legacy free-text)', () => {
  it('maps Ghana variants to GH', () => {
    expect(countryCodeFromLegacyText('Ghana')).toBe('GH');
    expect(countryCodeFromLegacyText('ghana')).toBe('GH');
    expect(countryCodeFromLegacyText('GH')).toBe('GH');
    expect(countryCodeFromLegacyText('gh')).toBe('GH');
    expect(countryCodeFromLegacyText(' GHA ')).toBe('GH');
  });

  it('leaves unknown text unmapped', () => {
    expect(countryCodeFromLegacyText('Gold Coast')).toBeNull();
    expect(countryCodeFromLegacyText('unknown place')).toBeNull();
    expect(countryCodeFromLegacyText('')).toBeNull();
    expect(countryCodeFromLegacyText(null)).toBeNull();
  });
});

describe('phone normalization (E.164, default Ghana)', () => {
  it('accepts the three Ghana formats and stores E.164', () => {
    expect(normalizePhoneToE164('0241234567', 'GH')).toBe('+233241234567');
    expect(normalizePhoneToE164('024 123 4567', 'GH')).toBe('+233241234567');
    expect(normalizePhoneToE164('+233 24 123 4567', 'GH')).toBe('+233241234567');
  });

  it('rejects an invalid number', () => {
    expect(normalizePhoneToE164('12345', 'GH')).toBeNull();
    expect(normalizePhoneToE164('02412', 'GH')).toBeNull();
    expect(normalizePhoneToE164('not-a-phone', 'GH')).toBeNull();
  });

  it('accepts a valid non-Ghana number when represented internationally', () => {
    expect(normalizePhoneToE164('+14155552671', 'US')).toBe('+14155552671');
  });
});

describe('Ghana Post GPS digital address', () => {
  it('accepts valid samples and normalizes', () => {
    expect(isValidGhanaPostGps('GA-123-4567')).toBe(true);
    expect(isValidGhanaPostGps('GA1234567'.replace(/^(..)(...)(....)$/, '$1-$2-$3'))).toBe(true);
    expect(normalizeGhanaPostGps('ga-123-4567')).toBe('GA-123-4567');
    expect(normalizeGhanaPostGps('AK-1234-5678')).toBe('AK-1234-5678');
  });

  it('rejects invalid samples', () => {
    expect(isValidGhanaPostGps('GA1234567')).toBe(false);
    expect(isValidGhanaPostGps('G-12-3456')).toBe(false);
    expect(isValidGhanaPostGps('GA-12-34567')).toBe(false);
    expect(isValidGhanaPostGps('12-123-4567')).toBe(false);
    expect(isValidGhanaPostGps('')).toBe(false);
  });
});
