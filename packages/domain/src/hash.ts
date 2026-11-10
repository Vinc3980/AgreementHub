import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './canonical.js';

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** SHA-256 hex digest of the canonical JSON encoding of a value. */
export function sha256Of(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}
