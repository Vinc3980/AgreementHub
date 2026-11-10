/**
 * Version snapshots (SPEC §11): build content from the working copy, hash it,
 * insert immutably, supersede predecessors, and compare two versions.
 */
import {
  AppError,
  canonicalJson,
  computeDocumentHash,
  sha256Hex,
  type VersionContent,
} from '@agreementhub/domain';
import type pg from 'pg';
import { many, one, type Queryable } from '../db.js';
import { listParties, type AgreementAccess, type AgreementRow } from './access.js';
import type { ActorContext } from './context.js';
import { parseTemplateDefinition } from '@agreementhub/domain/template';

export interface VersionRow {
  id: string;
  agreement_id: string;
  version_number: number;
  content: VersionContent;
  document_hash: string;
  previous_version_id: string | null;
  change_summary: string;
  status: 'DRAFT' | 'SUPERSEDED' | 'PENDING_APPROVAL' | 'APPROVED' | 'FINAL' | 'REJECTED';
  created_by: string;
  created_at: Date;
  finalized_at: Date | null;
}

interface SectionRow {
  code: string;
  title: string;
  body: string;
  included: boolean;
  order_index: number;
}

interface FieldRow {
  code: string;
  value: unknown;
  provenance: 'USER_PROVIDED' | 'AI_SUGGESTED_CONFIRMED' | 'COMPUTED';
}

/**
 * Build the canonical VersionContent snapshot from the agreement's working
 * copy (sections + fields + parties). Deterministic: same DB state ⇒ same
 * bytes ⇒ same hash.
 */
export async function buildContent(
  db: Queryable,
  agreementId: string,
  publicId: string,
  title: string,
  templateCode: string,
): Promise<VersionContent> {
  const sections = await many<SectionRow>(
    db,
    `SELECT code, title, body, included, order_index
     FROM agreement_sections WHERE agreement_id = $1
     ORDER BY order_index, code`,
    [agreementId],
  );
  const fields = await many<FieldRow>(
    db,
    `SELECT code, value, provenance FROM agreement_fields
     WHERE agreement_id = $1 ORDER BY code`,
    [agreementId],
  );
  const parties = await listParties(db, agreementId);

  return {
    agreementPublicId: publicId,
    title,
    templateCode,
    sections: sections.map((s) => ({
      code: s.code,
      title: s.title,
      body: s.body,
      included: s.included,
    })),
    fields: fields.map((f) => ({
      code: f.code,
      value: f.value,
      provenance: f.provenance,
    })),
    parties: parties.map((p) => ({
      email: p.email,
      displayName: p.display_name,
      role: p.role,
      signingOrder: p.signing_order,
    })),
  };
}

/**
 * Create a new version from the current working copy.
 * The previous current version (if any) becomes SUPERSEDED; the new version
 * starts as DRAFT and is only later promoted (APPROVED → FINAL).
 */
export async function insertVersion(
  db: Queryable,
  input: {
    agreementId: string;
    content: VersionContent;
    changeSummary: string;
    createdBy: string;
  },
): Promise<VersionRow> {
  const documentHash = computeDocumentHash(input.content);
  const prev = await one<{ id: string; status: string }>(
    db,
    `SELECT id, status FROM agreement_versions
     WHERE agreement_id = $1 ORDER BY version_number DESC LIMIT 1`,
    [input.agreementId],
  );

  // Supersede only committed-but-unfinalised predecessors; a FINAL version
  // must keep its status forever (trigger would reject the change anyway).
  if (prev && prev.status !== 'FINAL') {
    await db.query(
      `UPDATE agreement_versions SET status = 'SUPERSEDED' WHERE id = $1 AND status <> 'FINAL'`,
      [prev.id],
    );
  }

  const row = await one<VersionRow>(
    db,
    `INSERT INTO agreement_versions
       (agreement_id, version_number, content, document_hash, previous_version_id,
        change_summary, status, created_by)
     SELECT ag.id,
            COALESCE(MAX(v.version_number), 0) + 1,
            $2::jsonb,
            $3,
            $4,
            $5,
            'DRAFT',
            $6
     FROM agreements ag
     LEFT JOIN agreement_versions v ON v.agreement_id = ag.id
     WHERE ag.id = $1
     GROUP BY ag.id
     RETURNING *`,
    [
      input.agreementId,
      JSON.stringify(input.content),
      documentHash,
      prev?.id ?? null,
      input.changeSummary,
      input.createdBy,
    ],
  );
  if (!row) throw AppError.notFound('Agreement not found while creating version.');

  await db.query(`UPDATE agreements SET current_version_id = $1 WHERE id = $2`, [
    row.id,
    input.agreementId,
  ]);
  return row;
}

export async function getVersion(db: Queryable, versionId: string): Promise<VersionRow | undefined> {
  return one<VersionRow>(db, `SELECT * FROM agreement_versions WHERE id = $1`, [versionId]);
}

export async function listVersions(
  db: Queryable,
  agreementId: string,
): Promise<Array<Omit<VersionRow, 'content'> & { content?: undefined }>> {
  const rows = await many<VersionRow>(
    db,
    `SELECT * FROM agreement_versions WHERE agreement_id = $1 ORDER BY version_number ASC`,
    [agreementId],
  );
  // List view never ships full content (fetch individually when needed).
  return rows.map(({ content: _content, ...rest }) => rest);
}

export async function getLatestVersion(
  db: Queryable,
  agreementId: string,
): Promise<VersionRow | undefined> {
  return one<VersionRow>(
    db,
    `SELECT * FROM agreement_versions WHERE agreement_id = $1
     ORDER BY version_number DESC LIMIT 1`,
    [agreementId],
  );
}

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

export interface VersionDiff {
  fromVersion: number;
  toVersion: number;
  hashFrom: string;
  hashTo: string;
  changes: Array<{
    kind: 'section' | 'field' | 'party' | 'title';
    code: string;
    change: 'added' | 'removed' | 'modified';
    from?: unknown;
    to?: unknown;
  }>;
}

export function diffVersions(from: VersionRow, to: VersionRow): VersionDiff {
  const changes: VersionDiff['changes'] = [];

  if (from.content.title !== to.content.title) {
    changes.push({
      kind: 'title',
      code: 'title',
      change: 'modified',
      from: from.content.title,
      to: to.content.title,
    });
  }

  const diffList = <T extends Record<string, unknown>>(
    kind: 'section' | 'field' | 'party',
    a: T[],
    b: T[],
    keyOf: (x: T) => string,
    pick: (x: T) => unknown,
  ) => {
    const aMap = new Map(a.map((x) => [keyOf(x), x]));
    const bMap = new Map(b.map((x) => [keyOf(x), x]));
    for (const [code, av] of aMap) {
      const bv = bMap.get(code);
      if (!bv) {
        changes.push({ kind, code, change: 'removed', from: pick(av) });
      } else if (canonicalJson(pick(av)) !== canonicalJson(pick(bv))) {
        changes.push({ kind, code, change: 'modified', from: pick(av), to: pick(bv) });
      }
    }
    for (const [code, bv] of bMap) {
      if (!aMap.has(code)) changes.push({ kind, code, change: 'added', to: pick(bv) });
    }
  };

  diffList(
    'section',
    from.content.sections as unknown as Array<Record<string, unknown>>,
    to.content.sections as unknown as Array<Record<string, unknown>>,
    (s) => String(s.code),
    (s) => ({ title: s.title, body: s.body, included: s.included }),
  );
  diffList(
    'field',
    from.content.fields as unknown as Array<Record<string, unknown>>,
    to.content.fields as unknown as Array<Record<string, unknown>>,
    (f) => String(f.code),
    (f) => ({ value: f.value, provenance: f.provenance }),
  );
  diffList(
    'party',
    from.content.parties as unknown as Array<Record<string, unknown>>,
    to.content.parties as unknown as Array<Record<string, unknown>>,
    (p) => String(p.email), // parties are identified by email (unique per agreement)
    (p) => ({ displayName: p.displayName, role: p.role, signingOrder: p.signingOrder }),
  );

  return {
    fromVersion: from.version_number,
    toVersion: to.version_number,
    hashFrom: from.document_hash,
    hashTo: to.document_hash,
    changes,
  };
}

export { sha256Hex };

/**
 * Restore the mutable working copy (sections + fields) from an immutable
 * version snapshot. Used by amendment workflow so negotiation starts from the
 * finalized/sealed content, not stale working-copy rows.
 *
 * Parties are NOT rewritten here: they carry identity/invitation/signature
 * history and are managed separately. The version snapshot still records the
 * party state at seal time.
 */
export async function restoreWorkingCopyFromContent(
  db: Queryable,
  agreementId: string,
  content: VersionContent,
  actorUserId: string,
): Promise<void> {
  // Replace sections to match snapshot exactly (order and inclusion included).
  await db.query(`DELETE FROM agreement_sections WHERE agreement_id = $1`, [agreementId]);
  for (let i = 0; i < content.sections.length; i++) {
    const s = content.sections[i]!;
    await db.query(
      `INSERT INTO agreement_sections (agreement_id, code, title, body, order_index, included)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [agreementId, s.code, s.title, s.body ?? '', i, s.included !== false],
    );
  }

  // Replace fields to match snapshot exactly.
  await db.query(`DELETE FROM agreement_fields WHERE agreement_id = $1`, [agreementId]);
  for (const f of content.fields) {
    await db.query(
      `INSERT INTO agreement_fields (agreement_id, code, value, provenance, updated_by)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [
        agreementId,
        f.code,
        JSON.stringify(f.value ?? null),
        f.provenance ?? 'USER_PROVIDED',
        actorUserId,
      ],
    );
  }
}

/* ------------------------------------------------------------------ */
/* Change summaries                                                     */
/* ------------------------------------------------------------------ */

function humanizeCode(code: string): string {
  return code
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Derive a short human-readable summary by comparing two snapshots,
 * e.g. "Payment, scope modified". Used when an edit made during negotiation
 * automatically creates a new version, so the timeline reads like
 * "v2, Payment modified" without anyone having to type it.
 */
export function summarizeContentChange(
  from: VersionContent,
  to: VersionContent,
  fieldLabels: ReadonlyMap<string, string> = new Map(),
): string {
  const labelFor = (code: string) => fieldLabels.get(code) ?? humanizeCode(code);
  const labels: string[] = [];
  const push = (label: string) => {
    const clean = label.trim();
    if (clean && !labels.includes(clean)) labels.push(clean);
  };

  if (from.title !== to.title) push('Title');

  const sectionsFrom = new Map(from.sections.map((s) => [s.code, s]));
  const seenSections = new Set<string>();
  for (const s of to.sections) {
    seenSections.add(s.code);
    const prev = sectionsFrom.get(s.code);
    if (!prev || prev.title !== s.title || prev.body !== s.body || prev.included !== s.included) {
      push(s.title || humanizeCode(s.code));
    }
  }
  for (const s of from.sections) {
    if (!seenSections.has(s.code)) push(s.title || humanizeCode(s.code));
  }

  const fieldsFrom = new Map(from.fields.map((f) => [f.code, f]));
  const seenFields = new Set<string>();
  for (const f of to.fields) {
    seenFields.add(f.code);
    const prev = fieldsFrom.get(f.code);
    if (
      !prev ||
      canonicalJson(prev.value) !== canonicalJson(f.value) ||
      prev.provenance !== f.provenance
    ) {
      push(labelFor(f.code));
    }
  }
  for (const f of from.fields) {
    if (!seenFields.has(f.code)) push(labelFor(f.code));
  }

  if (canonicalJson(from.parties) !== canonicalJson(to.parties)) push('Parties');

  if (labels.length === 0) return 'Working copy updated';
  const shown = labels.slice(0, 4);
  const extra = labels.length - shown.length;
  return `${shown.join(', ')}${extra > 0 ? ` +${extra} more` : ''} modified`.slice(0, 500);
}

/* ------------------------------------------------------------------ */
/* Snapshot policy (shared by every content writer)                    */
/* ------------------------------------------------------------------ */

export interface VersionSyncResult {
  /** Non-null when a meaningful change was snapshotted into a new version. */
  versionCreated: VersionRow | null;
  /** True when the latest DRAFT version was refreshed in place. */
  versionRefreshed: boolean;
}

/** code → label map from the template definition (best effort). */
function fieldLabelsOf(template: { content_schema: unknown } | null | undefined): Map<string, string> {
  if (!template) return new Map();
  const definition = parseTemplateDefinition(template.content_schema);
  if (!definition) return new Map();
  return new Map(definition.fields.map((f) => [f.code, f.label]));
}

/**
 * Re-derive the document hash from the working copy and apply the snapshot
 * policy, the single place every content writer (draft PATCH, template
 * generate, accepted suggestion) ends up:
 *
 *  - while the agreement is under negotiation, any change that alters the
 *    hash creates a new immutable version with a derived summary
 *    ("Payment modified");
 *  - otherwise the latest DRAFT version is refreshed in place, so the working
 *    document always carries a hash-backed snapshot;
 *  - identical content changes nothing (no version, no refresh).
 */
export async function syncVersionAfterEdit(
  tx: Queryable,
  ctx: ActorContext,
  access: AgreementAccess,
): Promise<VersionSyncResult> {
  const agreementId = access.agreement.id;
  const latest = await one<{
    id: string;
    status: string;
    version_number: number;
    document_hash: string;
    content: VersionContent;
  }>(
    tx,
    `SELECT id, status, version_number, document_hash, content FROM agreement_versions
      WHERE agreement_id = $1 ORDER BY version_number DESC LIMIT 1`,
    [agreementId],
  );
  if (!latest) return { versionCreated: null, versionRefreshed: false };

  const ag = await one<AgreementRow>(tx, `SELECT * FROM agreements WHERE id = $1`, [agreementId]);
  if (!ag) return { versionCreated: null, versionRefreshed: false };

  const template = await one<{ name: string; content_schema: unknown }>(
    tx,
    `SELECT name, content_schema FROM agreement_templates WHERE id = $1`,
    [ag.template_id ?? ''],
  );

  const content = await buildContent(tx, ag.id, ag.public_id, ag.title, template?.name ?? '');
  const documentHash = computeDocumentHash(content);
  if (documentHash === latest.document_hash) {
    return { versionCreated: null, versionRefreshed: false };
  }

  if (access.agreement.status === 'NEGOTIATION') {
    // Meaningful modification under negotiation ⇒ own immutable version.
    const versionCreated = await insertVersion(tx, {
      agreementId,
      content,
      changeSummary: summarizeContentChange(latest.content, content, fieldLabelsOf(template)),
      createdBy: ctx.userId,
    });
    return { versionCreated, versionRefreshed: false };
  }

  if (latest.status === 'DRAFT') {
    // Refresh the DRAFT version in place so the working document always has a
    // hash-backed snapshot (committed versions are immutable).
    await tx.query(
      `UPDATE agreement_versions SET content = $1::jsonb, document_hash = $2 WHERE id = $3`,
      [JSON.stringify(content), documentHash, latest.id],
    );
    return { versionCreated: null, versionRefreshed: true };
  }

  return { versionCreated: null, versionRefreshed: false };
}
