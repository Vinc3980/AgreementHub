/**
 * Vitest global setup: (re)creates the test database schema, applies all
 * migrations and seeds templates. Runs once per `vitest run`.
 *
 * The test database must contain "test" in its name, this setup drops the
 * public schema, so it must never point at a real database.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://agreementhub:agreementhub@127.0.0.1:5432/agreementhub_test';

function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.slice(1);
  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to reset non-test database "${name}". Set TEST_DATABASE_URL to a database whose name contains "test".`,
    );
  }
}

function sqlFiles(dir: string): Array<{ name: string; path: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, path: join(dir, f) }));
}

export default async function globalSetup(): Promise<void> {
  assertTestDatabase(TEST_DATABASE_URL);

  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of sqlFiles(join(REPO_ROOT, 'db', 'migrations'))) {
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(file.path, 'utf8'));
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`);
      }
    }

    for (const file of sqlFiles(join(REPO_ROOT, 'db', 'seeds'))) {
      await client.query(readFileSync(file.path, 'utf8'));
    }
  } finally {
    await client.end();
  }
}
