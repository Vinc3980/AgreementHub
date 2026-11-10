/**
 * Seed: 5 template categories + starter templates (SPEC §FR-2).
 * Idempotent, safe to re-run. Usage: DATABASE_URL=... npm run db:seed
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEDS_DIR = join(__dirname, 'seeds');

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
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const files = readdirSync(SEEDS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = readFileSync(join(SEEDS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
        console.log(`seeded ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Seed ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
