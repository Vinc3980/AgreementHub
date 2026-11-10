/**
 * Public Agreement ID: AGR-GH-2026-000001 (SPEC §4).
 *
 * Internal primary keys are UUIDs; the public ID is a separate, human-readable
 * identifier allocated from a per-year counter (never derived from the UUID).
 */

export const PUBLIC_ID_PATTERN = /^(?<prefix>[A-Z]{2,4}-[A-Z]{2,4})-(?<year>\d{4})-(?<seq>\d{6})$/;

export interface ParsedPublicId {
  prefix: string;
  year: number;
  sequence: number;
}

export function isValidPublicId(id: string, expectedPrefix?: string): boolean {
  const m = PUBLIC_ID_PATTERN.exec(id);
  const groups = m?.groups;
  if (!groups?.prefix) return false;
  if (expectedPrefix && groups.prefix !== expectedPrefix) return false;
  return true;
}

export function parsePublicId(id: string): ParsedPublicId {
  const m = PUBLIC_ID_PATTERN.exec(id);
  const groups = m?.groups;
  if (!groups?.prefix || !groups.year || !groups.seq) throw new Error(`Malformed Agreement ID: ${id}`);
  return {
    prefix: groups.prefix,
    year: Number(groups.year),
    sequence: Number(groups.seq),
  };
}

/** Format a counter value into the public ID, e.g. formatPublicId('AGR-GH', 2026, 1). */
export function formatPublicId(prefix: string, year: number, sequence: number): string {
  if (!/^[A-Z]{2,4}-[A-Z]{2,4}$/.test(prefix)) throw new Error(`Invalid ID prefix: ${prefix}`);
  if (sequence < 1 || sequence > 999999) throw new Error(`Sequence out of range: ${sequence}`);
  return `${prefix}-${year}-${String(sequence).padStart(6, '0')}`;
}
