/**
 * Database access: a shared pg Pool plus transaction and query helpers.
 * All multi-statement mutations run inside withTransaction so that audit
 * events commit atomically with the state change they describe.
 */
import pg from 'pg';
import type { Config } from './config.js';

const { Pool } = pg;

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

/**
 * Minimal structural interface satisfied by both Pool and PoolClient.
 * (@types/pg does not export a Queryable type.)
 */
export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<T>>;
}

export function createPool(config: Config): Db {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: config.NODE_ENV === 'test' ? 5 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/** Run fn inside a dedicated connection with BEGIN/COMMIT/ROLLBACK. */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection may already be broken; original error is rethrown below
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Fetch at most one row, or undefined. */
export async function one<T extends pg.QueryResultRow>(
  db: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<T | undefined> {
  const res = await db.query<T>(text, values);
  return res.rows[0];
}

/** Fetch all rows. */
export async function many<T extends pg.QueryResultRow>(
  db: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(text, values);
  return res.rows;
}

/** Execute a statement, returning the raw result (for rowCount checks). */
export async function exec(
  db: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult> {
  return db.query(text, values);
}
