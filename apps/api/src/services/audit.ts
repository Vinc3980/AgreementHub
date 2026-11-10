/**
 * Audit service (SPEC §12).
 *
 * - Every significant agreement event MUST go through recordAudit().
 * - Events are appended inside the caller's transaction: no state change
 *   commits without its audit event, and vice versa.
 * - Per-agreement hash chain: seq = max(seq)+1, prev_hash = previous
 *   event_hash, event_hash = SHA-256(prev_hash || canonical(event body)).
 *   DB triggers block UPDATE/DELETE on audit_events for everyone.
 */
import {
  AppError,
  canonicalJson,
  sha256Hex,
  type AuditEventType,
  isAuditEventType,
} from '@agreementhub/domain';
import type pg from 'pg';
import { many, one, type Queryable } from '../db.js';

export interface AuditActor {
  type: 'USER' | 'GUEST' | 'SYSTEM' | 'AI';
  id?: string | null;
  label?: string;
}

export interface RecordAuditInput {
  agreementId?: string | null;
  orgId?: string | null;
  eventType: AuditEventType;
  actor: AuditActor;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
}

export interface AuditEventRow {
  id: string;
  agreement_id: string | null;
  org_id: string | null;
  seq: string | null;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string;
  metadata: Record<string, unknown>;
  request_id: string | null;
  occurred_at: Date;
  prev_hash: string | null;
  event_hash: string;
}

const GENESIS_HASH = '0'.repeat(64);

export async function recordAudit(
  db: Queryable,
  input: RecordAuditInput,
): Promise<AuditEventRow> {
  if (!isAuditEventType(input.eventType)) {
    throw new AppError(500, 'UNKNOWN_AUDIT_EVENT', `Unregistered audit event type: ${input.eventType}`);
  }
  if (!input.agreementId && !input.orgId) {
    throw new AppError(500, 'AUDIT_SCOPE_REQUIRED', 'Audit events require an agreement_id or org_id scope.');
  }

  // Serialize chain head reads per agreement via advisory lock when in a tx.
  if (input.agreementId) {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${input.agreementId}`]);
    const head = await one<{ seq: string | null; event_hash: string }>(
      db,
      `SELECT seq, event_hash FROM audit_events
       WHERE agreement_id = $1
       ORDER BY seq DESC NULLS LAST
       LIMIT 1`,
      [input.agreementId],
    );
    const seq = head?.seq ? Number(head.seq) + 1 : 1;
    const prevHash = head?.event_hash ?? GENESIS_HASH;
    return insertChained(db, input, seq, prevHash);
  }

  // Org-scope events: chain on org head (seq kept NULL for agreement-unique index).
  const head = await one<{ event_hash: string }>(
    db,
    `SELECT event_hash FROM audit_events
     WHERE org_id = $1 AND agreement_id IS NULL
     ORDER BY occurred_at DESC
     LIMIT 1`,
    [input.orgId],
  );
  return insertChained(db, input, null, head?.event_hash ?? GENESIS_HASH);
}

async function insertChained(
  db: Queryable,
  input: RecordAuditInput,
  seq: number | null,
  prevHash: string,
): Promise<AuditEventRow> {
  const occurredAt = new Date().toISOString();
  const metadata = input.metadata ?? {};
  // Hash covers everything that identifies the event, incl. the chain link.
  const eventHash = sha256Hex(
    prevHash +
      canonicalJson({
        agreementId: input.agreementId ?? null,
        orgId: input.orgId ?? null,
        seq,
        eventType: input.eventType,
        actorType: input.actor.type,
        actorId: input.actor.id ?? null,
        actorLabel: input.actor.label ?? '',
        metadata,
        requestId: input.requestId ?? null,
        occurredAt,
      }),
  );

  const row = await one<AuditEventRow>(
    db,
    `INSERT INTO audit_events
       (agreement_id, org_id, seq, event_type, actor_type, actor_id, actor_label,
        metadata, request_id, occurred_at, prev_hash, event_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      input.agreementId ?? null,
      input.orgId ?? null,
      seq,
      input.eventType,
      input.actor.type,
      input.actor.id ?? null,
      input.actor.label ?? '',
      JSON.stringify(metadata),
      input.requestId ?? null,
      occurredAt,
      prevHash,
      eventHash,
    ],
  );
  if (!row) throw new AppError(500, 'AUDIT_INSERT_FAILED', 'Failed to append audit event.');
  return row;
}

/**
 * Walk an agreement's chain and verify every link.
 * Returns the number of verified events; throws on any break.
 */
export async function verifyAuditChain(
  db: Queryable,
  agreementId: string,
): Promise<number> {
  const rows = await many<AuditEventRow>(
    db,
    `SELECT * FROM audit_events WHERE agreement_id = $1 ORDER BY seq ASC`,
    [agreementId],
  );
  let prev = GENESIS_HASH;
  for (const row of rows) {
    if (row.prev_hash !== prev) {
      throw new AppError(500, 'AUDIT_CHAIN_BROKEN', `Chain break at seq ${row.seq}: prev_hash mismatch.`);
    }
    const expected = sha256Hex(
      prev +
        canonicalJson({
          agreementId: row.agreement_id,
          orgId: row.org_id,
          seq: row.seq === null ? null : Number(row.seq),
          eventType: row.event_type,
          actorType: row.actor_type,
          actorId: row.actor_id,
          actorLabel: row.actor_label,
          metadata: row.metadata,
          requestId: row.request_id,
          occurredAt: new Date(row.occurred_at).toISOString(),
        }),
    );
    if (expected !== row.event_hash) {
      throw new AppError(500, 'AUDIT_CHAIN_BROKEN', `Chain break at seq ${row.seq}: event_hash mismatch.`);
    }
    prev = row.event_hash;
  }
  return rows.length;
}
