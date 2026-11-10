/**
 * Shared test harness: builds the Fastify app against the test database,
 * resets data between tests, and provides small API/flow helpers.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  findMissingRequired,
  parseTemplateDefinition,
  type TemplateValues,
} from '@agreementhub/domain/template';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Db } from '../src/db.js';
import { TEST_DATABASE_URL } from './env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SEED_SQL = readFileSync(join(REPO_ROOT, 'db', 'seeds', '0001_templates.sql'), 'utf8');

export function testConfig(overrides: Partial<Config> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: 0, // disable global rate limiting in tests
    AUTH_RATE_LIMIT_MAX: 100_000,
    // Capture emails in-process instead of logging them during tests.
    EMAIL_TRANSPORT: 'memory',
    SCHEDULER_INTERVAL_MS: 0,
    // PDF generation is opt-in per test file (documents.test.ts turns it on):
    // most suites never render, keeping the suite fast and browser-free.
    PDF_GENERATION: 'off',
    ...overrides,
  });
}

/** Wipe all data and re-seed template categories/templates. */
export async function resetTestDb(db: Db): Promise<void> {
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length > 0) {
    const list = rows.map((r) => `"${r.tablename}"`).join(', ');
    await db.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  }
  await db.query(SEED_SQL);
}

export interface TestHarness {
  app: FastifyInstance;
  db: Db;
}

/** Registers beforeAll/afterAll/beforeEach hooks; returns a live harness getter. */
export function useTestApp(overrides: Partial<Config> = {}): () => TestHarness {
  let app: FastifyInstance | undefined;
  let db: Db | undefined;

  beforeAll(async () => {
    const config = testConfig(overrides);
    db = createPool(config);
    app = await buildApp({ config, db });
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  beforeEach(async () => {
    await resetTestDb(db!);
  });

  return () => ({ app: app!, db: db! });
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function post(
  h: TestHarness,
  url: string,
  body: unknown,
  token?: string,
) {
  return h.app.inject({
    method: 'POST',
    url,
    payload: body as object,
    headers: token ? authHeaders(token) : {},
  });
}

export async function get(h: TestHarness, url: string, token?: string) {
  return h.app.inject({
    method: 'GET',
    url,
    headers: token ? authHeaders(token) : {},
  });
}

export async function patch(
  h: TestHarness,
  url: string,
  body: unknown,
  token?: string,
) {
  return h.app.inject({
    method: 'PATCH',
    url,
    payload: body as object,
    headers: token ? authHeaders(token) : {},
  });
}

export async function del(h: TestHarness, url: string, token?: string) {
  return h.app.inject({
    method: 'DELETE',
    url,
    headers: token ? authHeaders(token) : {},
  });
}

/* ------------------------------------------------------------------ */
/* Domain helpers                                                      */
/* ------------------------------------------------------------------ */

let emailCounter = 0;
export function uniqueEmail(prefix = 'user'): string {
  emailCounter += 1;
  return `${prefix}-${Date.now()}-${emailCounter}@example.com`;
}

export interface TestUser {
  token: string;
  userId: string;
  email: string;
  orgId: string;
}

export const TEST_PASSWORD = 'Password123';

export async function registerUser(
  h: TestHarness,
  email: string = uniqueEmail(),
  password: string = TEST_PASSWORD,
  options: { verify?: boolean } = {},
): Promise<TestUser> {
  const res = await post(h, '/api/v1/auth/register', {
    email,
    password,
    displayName: 'Test User',
  });
  if (res.statusCode !== 201) {
    throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json();
  // Real users must prove control of their inbox before accepting invitations;
  // tests do the same by consuming the queued verification token.
  if (options.verify !== false) {
    await verifyEmailForTest(h, email);
  }
  return {
    token: body.token as string,
    userId: body.user.id as string,
    email: body.user.email as string,
    orgId: body.organizations[0].id as string,
  };
}

/** Register an account that deliberately remains unverified. */
export async function registerUnverifiedUser(
  h: TestHarness,
  email: string = uniqueEmail(),
): Promise<TestUser> {
  return registerUser(h, email, TEST_PASSWORD, { verify: false });
}

/** Pull the latest queued verification token and consume it via the API. */
export async function verifyEmailForTest(h: TestHarness, email: string): Promise<void> {
  const { rows } = await h.db.query<{ payload: { token?: string } }>(
    `SELECT payload FROM email_outbox
      WHERE lower(to_email) = lower($1) AND template = 'EMAIL_VERIFICATION'
      ORDER BY created_at DESC LIMIT 1`,
    [email],
  );
  const token = rows[0]?.payload?.token;
  if (!token) throw new Error(`no verification email queued for ${email}`);
  const res = await post(h, '/api/v1/auth/verify-email/confirm', { token });
  if (res.statusCode !== 200) {
    throw new Error(`email verification failed: ${res.statusCode} ${res.body}`);
  }
}

/** Latest queued email (any template) for an address, used by tests. */
export async function latestEmailFor(
  h: TestHarness,
  email: string,
  template?: string,
): Promise<{ template: string; payload: Record<string, unknown>; status: string } | null> {
  const { rows } = await h.db.query<{
    template: string;
    payload: Record<string, unknown>;
    status: string;
  }>(
    `SELECT template, payload, status FROM email_outbox
      WHERE lower(to_email) = lower($1)
        AND ($2::text IS NULL OR template = $2)
      ORDER BY created_at DESC LIMIT 1`,
    [email, template ?? null],
  );
  return rows[0] ?? null;
}

export async function firstTemplateId(db: Db, categoryCode?: string): Promise<string> {
  // Latest published version, matching the public template picker.
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM (
       SELECT DISTINCT ON (t.category_id, t.name) t.id, t.name
         FROM agreement_templates t
         JOIN template_categories c ON c.id = t.category_id
        WHERE t.status = 'PUBLISHED'
          AND ($1::text IS NULL OR c.code = $1)
        ORDER BY t.category_id, t.name, t.template_version DESC
     ) latest
     ORDER BY name LIMIT 1`,
    [categoryCode ?? null],
  );
  if (!rows[0]) throw new Error('No seeded templates found');
  return rows[0].id;
}

export async function createAgreement(
  h: TestHarness,
  token: string,
  templateId: string,
  title = 'Test Agreement',
) {
  const res = await post(h, '/api/v1/agreements', { templateId, title }, token);
  if (res.statusCode !== 201) {
    throw new Error(`createAgreement failed: ${res.statusCode} ${res.body}`);
  }
  const parsed = res.json() as {
    agreement: { id: string; publicId: string; status: string };
    initialVersion: { id: string; versionNumber: number; documentHash: string; status: string };
  };
  // Complete required template fields so lifecycle flows (approval request,
  // signature request, finalize) pass the MISSING_REQUIRED_FIELDS gate.
  await fillRequiredFields(h, token, parsed.agreement.id, templateId);
  // Filling fields refreshes the draft version hash, re-read so callers get
  // an initialVersion that matches the completed working copy.
  const refreshed = await get(h, `/api/v1/agreements/${parsed.agreement.id}`, token);
  const current = refreshed.json().currentVersion as
    | { id: string; versionNumber: number; documentHash: string; status: string }
    | null;
  if (current) {
    parsed.initialVersion = {
      id: current.id,
      versionNumber: current.versionNumber,
      documentHash: current.documentHash,
      status: current.status,
    };
  }
  return parsed;
}

/** Representative per-type values for auto-completing required fields. */
const SAMPLE_FIELD_VALUES: Record<string, string> = {
  text: 'Test value',
  textarea: 'Test value',
  number: '5',
  money: '1000',
  date: '2026-12-31',
  email: 'test@example.com',
};

/**
 * Fill every visible required field of an agreement's template until no
 * required fields remain (filling a select can reveal conditional fields).
 * Skips templates with unparseable definitions by throwing, seeds are
 * contract-tested separately.
 */
export async function fillRequiredFields(
  h: TestHarness,
  token: string,
  agreementId: string,
  templateId: string,
): Promise<void> {
  const tpl = await get(h, `/api/v1/templates/${templateId}`, token);
  if (tpl.statusCode !== 200) {
    throw new Error(`fillRequiredFields: template fetch failed ${tpl.statusCode}`);
  }
  const raw = (tpl.json() as { template: { content_schema: unknown } }).template.content_schema;
  const definition = parseTemplateDefinition(raw);
  if (!definition) throw new Error('fillRequiredFields: template definition unparseable');

  for (let round = 0; round < 5; round++) {
    const detail = await get(h, `/api/v1/agreements/${agreementId}`, token);
    if (detail.statusCode !== 200) {
      throw new Error(`fillRequiredFields: detail fetch failed ${detail.statusCode}`);
    }
    const current: TemplateValues = {};
    for (const f of detail.json().fields as Array<{ code: string; value: unknown }>) {
      current[f.code] = f.value as TemplateValues[string];
    }
    const missing = findMissingRequired(definition, current);
    if (missing.length === 0) return;

    const fields = missing.map((m) => {
      const def = definition.fields.find((f) => f.code === m.code);
      const value =
        def?.type === 'select'
          ? (def.options?.[0] ?? 'Test value')
          : (SAMPLE_FIELD_VALUES[def?.type ?? 'text'] ?? 'Test value');
      return { code: m.code, value, provenance: 'USER_PROVIDED' as const };
    });
    const res = await patch(h, `/api/v1/agreements/${agreementId}`, { fields }, token);
    if (res.statusCode !== 200) {
      throw new Error(`fillRequiredFields failed: ${res.statusCode} ${res.body}`);
    }
  }
  throw new Error('fillRequiredFields did not converge within 5 rounds');
}

export interface SigningSetup {
  owner: TestUser;
  counterparty: TestUser;
  counterEmail: string;
  agreementId: string;
  publicId: string;
  templateId: string;
}

/**
 * Drive an agreement up to AWAITING_SIGNATURES with an APPROVED version:
 * owner creates it, invites a counterparty (SIGNER) who accepts, submits for
 * review, and the owner's approval satisfies the approval policy (required=1).
 */
export async function setupAwaitingSignatures(h: TestHarness): Promise<SigningSetup> {
  const owner = await registerUser(h, uniqueEmail('owner'));
  const templateId = await firstTemplateId(h.db);
  const created = await createAgreement(h, owner.token, templateId);
  const agreementId = created.agreement.id;

  const counterEmail = uniqueEmail('signer');
  const inviteRes = await post(
    h,
    `/api/v1/agreements/${agreementId}/parties`,
    { email: counterEmail, role: 'SIGNER' },
    owner.token,
  );
  if (inviteRes.statusCode !== 201) {
    throw new Error(`invite failed: ${inviteRes.statusCode} ${inviteRes.body}`);
  }
  const invite = inviteRes.json() as { invitation: { token: string } };
  const counterparty = await registerUser(h, counterEmail);
  const acceptRes = await post(
    h,
    '/api/v1/parties/accept-invitation',
    { token: invite.invitation.token },
    counterparty.token,
  );
  if (acceptRes.statusCode !== 200) {
    throw new Error(`accept failed: ${acceptRes.statusCode} ${acceptRes.body}`);
  }

  const submit = await post(h, `/api/v1/agreements/${agreementId}/status`, { to: 'REVIEW' }, owner.token);
  if (submit.statusCode !== 200) {
    throw new Error(`submit failed: ${submit.statusCode} ${submit.body}`);
  }
  await post(h, '/api/v1/approvals/request', { agreementId }, owner.token);
  const approval = await post(
    h,
    '/api/v1/approvals',
    { agreementId, decision: 'APPROVED' },
    owner.token,
  );
  if (approval.statusCode !== 200) {
    throw new Error(`approval failed: ${approval.statusCode} ${approval.body}`);
  }

  return {
    owner,
    counterparty,
    counterEmail,
    agreementId,
    publicId: created.agreement.publicId,
    templateId,
  };
}
