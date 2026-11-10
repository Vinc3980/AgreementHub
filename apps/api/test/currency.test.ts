import { describe, expect, it } from 'vitest';
import {
  amountInWords,
  CURRENCIES,
  formatMoney,
  formatMoneyDocument,
  hasMaxDecimals,
  isValidGhanaPhone,
  normalizeGhanaPhone,
  normalizeMoneyString,
  parseMoneyAmount,
  validateMoneyValue,
} from '@agreementhub/domain/currency';

describe('amountInWords', () => {
  it('formats the required GHS example with pesewas', () => {
    expect(amountInWords(5000.5, 'GHS')).toBe(
      'GHS 5,000.50 (Five Thousand Ghana Cedis and Fifty Pesewas)',
    );
  });

  it('handles zero, 1, and 100', () => {
    expect(amountInWords(0, 'GHS')).toBe('GHS 0.00 (Zero Ghana Cedis)');
    expect(amountInWords(1, 'GHS')).toBe('GHS 1.00 (One Ghana Cedi)');
    expect(amountInWords(100, 'GHS')).toBe('GHS 100.00 (One Hundred Ghana Cedis)');
  });

  it('handles one pesewa and pesewas only', () => {
    expect(amountInWords(0.01, 'GHS')).toBe('GHS 0.01 (One Pesewa)');
    expect(amountInWords(0.75, 'GHS')).toBe('GHS 0.75 (Seventy Five Pesewas)');
  });

  it('handles whole cedi amounts', () => {
    expect(amountInWords(3500, 'GHS')).toBe(
      'GHS 3,500.00 (Three Thousand Five Hundred Ghana Cedis)',
    );
  });

  it('handles large numbers including 1,000,000.99', () => {
    expect(amountInWords(1000000.99, 'GHS')).toBe(
      'GHS 1,000,000.99 (One Million Ghana Cedis and Ninety Nine Pesewas)',
    );
    expect(amountInWords(1234567.89, 'GHS')).toBe(
      'GHS 1,234,567.89 (One Million Two Hundred Thirty Four Thousand Five Hundred Sixty Seven Ghana Cedis and Eighty Nine Pesewas)',
    );
  });

  it('rounds fractional minor units to the currency precision', () => {
    expect(amountInWords(10.005, 'GHS')).toBe('GHS 10.01 (Ten Ghana Cedis and One Pesewa)');
  });

  it('falls back sensibly for non-GHS currencies', () => {
    expect(amountInWords(10.5, 'USD')).toBe('USD 10.50 (Ten US Dollars and Fifty Cents)');
    expect(amountInWords(10, 'XYZ')).toBe('XYZ 10.00 (XYZ)');
  });

  it('uses ISO code in the formatted prefix (no ₵ symbol)', () => {
    expect(amountInWords(1, 'GHS').startsWith('GHS ')).toBe(true);
    expect(amountInWords(1, 'GHS')).not.toContain('₵');
  });
});

describe('currency list and formatting', () => {
  it('lists GHS first and marks it as the cedi (default currency for v2 templates)', () => {
    expect(CURRENCIES[0]?.code).toBe('GHS');
    expect(CURRENCIES[0]?.name).toMatch(/Ghana Cedi/i);
  });

  it('formats money output safely (₵ fallback logic: never throws; represents amount)', () => {
    expect(formatMoneyDocument(5000.5, 'GHS')).toBe('GHS 5,000.50');
    const web = formatMoney(5000.5, 'GHS');
    expect(typeof web).toBe('string');
    expect(web).toMatch(/5/);
    // formatMoney may use currency symbol where runtime supports it; callers avoid ₵ in unsafe fonts.
  });
});

describe('money parsing and validation', () => {
  it('parses grouped and pasted currency values', () => {
    expect(parseMoneyAmount('GH₵5,000')).toBe(5000);
    expect(parseMoneyAmount('5,000.5')).toBe(5000.5);
    expect(parseMoneyAmount('5,000')).toBe(5000);
  });

  it('validates money rules (negatives/non-numbers/>2 decimals)', () => {
    expect(validateMoneyValue('GH₵5,000')).toBeNull();
    expect(validateMoneyValue('5,000.5')).toBeNull();
    expect(validateMoneyValue('-5')).toBe('must not be negative');
    expect(validateMoneyValue('abc')).toBe('must be a number');
    expect(validateMoneyValue('1.234')).toBe('must have no more than 2 decimal places');
    expect(validateMoneyValue('')).toBeNull();
  });

  it('checks decimal limits and normalizes', () => {
    expect(hasMaxDecimals(1.23, 2)).toBe(true);
    expect(hasMaxDecimals(1.234, 2)).toBe(false);
    expect(normalizeMoneyString('5,000.50', 2)).toBe('5000.5');
  });
});

describe('Ghana phone validation', () => {
  it('normalizes local and international forms', () => {
    expect(normalizeGhanaPhone('024 123 4567')).toBe('0241234567');
    expect(normalizeGhanaPhone('+233 24 123 4567')).toBe('0241234567');
    expect(normalizeGhanaPhone('233241234567')).toBe('0241234567');
  });

  it('rejects invalid numbers', () => {
    expect(isValidGhanaPhone('12345')).toBe(false);
    expect(isValidGhanaPhone('')).toBe(false);
    expect(isValidGhanaPhone('024123456')).toBe(false);
  });
});
