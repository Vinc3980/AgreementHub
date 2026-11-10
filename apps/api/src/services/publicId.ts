/**
 * Public Agreement ID allocation (SPEC §4): AGR-GH-2026-000001.
 * Per-year counters with row locking, never derived from the UUID PK.
 */
import { formatPublicId } from '@agreementhub/domain';
import type pg from 'pg';
import { one, type Queryable } from '../db.js';

export async function allocatePublicId(db: Queryable, prefix: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const key = `${prefix}-${year}`;

  // First use: seed the counter inside the same transaction (row lock held
  // for the remainder of the tx by the subsequent UPDATE).
  const seeded = await one<{ next_value: string }>(
    db,
    `INSERT INTO id_counters (key, next_value) VALUES ($1, 1)
     ON CONFLICT (key) DO NOTHING
     RETURNING next_value`,
    [key],
  );

  const row = await one<{ next_value: string }>(
    db,
    `UPDATE id_counters SET next_value = next_value + 1, updated_at = now()
     WHERE key = $1
     RETURNING next_value - 1 AS next_value`,
    [key],
  );
  if (!row) throw new Error(`Failed to allocate Agreement ID counter for ${key}`);
  void seeded;
  return formatPublicId(prefix, year, Number(row.next_value));
}
