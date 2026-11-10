/**
 * Canonical JSON serialization.
 *
 * Two machines must produce byte-identical output for the same logical value so
 * that SHA-256 document hashes are reproducible (SPEC §11.3).
 *
 * Rules:
 *  - object keys sorted lexicographically (code-unit order)
 *  - no insignificant whitespace
 *  - strings: NFC-normalised, CRLF/CR normalised to LF
 *  - undefined values dropped (as in JSON.stringify)
 *  - numbers must be finite (throws otherwise), no NaN/Infinity leaking into hashes
 *  - Date serialised as ISO-8601 UTC string
 */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | CanonicalValue[]
  | { [key: string]: unknown }
  | Date;

function normaliseString(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n');
}

function canonicalise(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null'; // treated as absent → serialised as null in arrays

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('Cannot canonicalise invalid Date');
    return JSON.stringify(value.toISOString());
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot canonicalise non-finite number: ${value}`);
    return JSON.stringify(value);
  }

  if (typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(typeof value === 'string' ? normaliseString(value) : value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalise(v)).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((key) => {
      const v = obj[key];
      if (v === undefined) return null; // drop undefined members, like JSON.stringify
      if (typeof v === 'function' || typeof v === 'symbol') return null;
      return `${JSON.stringify(key)}:${canonicalise(v)}`;
    })
    .filter((x): x is string => x !== null);

  return `{${entries.join(',')}}`;
}

/** Serialise a value to canonical JSON text. */
export function canonicalJson(value: unknown): string {
  return canonicalise(value);
}
