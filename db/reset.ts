/**
 * Reset the target database: drops all tables/views/sequences in the public
 * schema and re-applies migrations. Destructive, refuses to run without
 * AH_CONFIRM_RESET=1 or a database name containing "test".
 *
 * Usage: AH_CONFIRM_RESET=1 DATABASE_URL=... npm run db:reset
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from './migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

for (const envPath of [resolve(process.cwd(), '.env'), resolve(__dirname, '../.env')]) {
  try {
    if (existsSync(envPath)) process.loadEnvFile(envPath);
  } catch {
    // optional
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const looksLikeTest = /test/i.test(new URL(url).pathname);
  if (!looksLikeTest && process.env.AH_CONFIRM_RESET !== '1') {
    console.error('Refusing to reset a non-test database without AH_CONFIRM_RESET=1');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    console.log('schema dropped');
  } finally {
    await client.end();
  }

  await migrate(url);
  console.log('database reset complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
