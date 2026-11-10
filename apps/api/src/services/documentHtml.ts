/**
 * Assembles the renderable document for a version: the stored snapshot
 * content, template/category metadata, and the signature records bound to
 * that version. Shared by the HTML download/preview routes, the PDF route,
 * and the finalization pipeline so every output renders from one source.
 */
import type { VersionContent } from '@agreementhub/domain';
import type { Config } from '../config.js';
import { webBaseUrl } from '../config.js';
import { parseTemplateDefinition } from '@agreementhub/domain/template';
import { many, one, type Queryable } from '../db.js';
import {
  renderDocumentHtml,
  type RenderDocumentInput,
  type RenderSignature,
} from './render.js';

export interface RenderableAgreement {
  id: string;
  public_id: string;
  template_id: string;
  category_id: string;
}

export interface RenderableVersion {
  id: string;
  version_number: number;
  status: string;
  document_hash: string;
  content: VersionContent;
  created_at: Date;
  finalized_at: Date | null;
}

interface SignatureJoinRow {
  signer_email: string;
  signed_at: Date;
  method: string;
  signature_text: string | null;
  signature_data: { image?: string } | null;
  role: string | null;
  display_name: string | null;
}

/** Load a version snapshot by number, or null when it does not exist. */
export async function loadRenderableVersion(
  db: Queryable,
  agreementId: string,
  versionNumber: number,
): Promise<RenderableVersion | null> {
  const row = await one<RenderableVersion>(
    db,
    `SELECT id, version_number, status, document_hash, content, created_at, finalized_at
     FROM agreement_versions
     WHERE agreement_id = $1 AND version_number = $2`,
    [agreementId, versionNumber],
  );
  return row ?? null;
}

/** Full render input for a version (content + metadata + signatures). */
export async function buildRenderDocumentInput(
  db: Queryable,
  config: Config,
  agreement: RenderableAgreement,
  version: RenderableVersion,
): Promise<RenderDocumentInput> {
  // Sequential on purpose: callers may pass a transaction (single client),
  // and concurrent queries on one client are deprecated in pg.
  const template = await one<{ name: string; content_schema: unknown }>(
    db,
    `SELECT name, content_schema FROM agreement_templates WHERE id = $1`,
    [agreement.template_id],
  );
  const category = await one<{ name: string }>(
    db,
    `SELECT label AS name FROM template_categories WHERE id = $1`,
    [agreement.category_id],
  );
  const definition = parseTemplateDefinition(template?.content_schema);
  const fieldLabels: Record<string, string> = {};
  if (definition) {
    for (const f of definition.fields) fieldLabels[f.code] = f.label;
  }
  const signatureRows = await many<SignatureJoinRow>(
    db,
    `SELECT s.signer_email, s.signed_at, s.method, s.signature_text, s.signature_data,
            p.role, p.display_name
     FROM signatures s
     LEFT JOIN agreement_parties p ON p.id = s.party_id
     WHERE s.version_id = $1
     ORDER BY s.signed_at`,
    [version.id],
  );
  // Live roster: invitations land after the snapshot is taken and signatures
  // after it is sealed, the document must show the real parties today.
  const partyRows = await many<{
    email: string;
    display_name: string;
    role: string;
    signing_order: number;
  }>(
    db,
    `SELECT email, display_name, role, signing_order
     FROM agreement_parties
     WHERE agreement_id = $1 AND status <> 'DECLINED'
     ORDER BY signing_order, added_at`,
    [agreement.id],
  );

  const signatures: RenderSignature[] = signatureRows.map((s) => ({
    signerEmail: s.signer_email,
    displayName: s.display_name && s.display_name.length > 0 ? s.display_name : null,
    partyRole: s.role ?? 'SIGNER',
    signedAt: s.signed_at,
    method: s.method,
    signatureText: s.signature_text,
    signatureImage: s.signature_data?.image ?? null,
  }));

  return {
    publicId: agreement.public_id,
    versionNumber: version.version_number,
    versionStatus: version.status,
    documentHash: version.document_hash,
    content: version.content,
    parties: partyRows.map((p) => ({
      email: p.email,
      displayName: p.display_name,
      role: p.role,
      signingOrder: p.signing_order,
    })),
    templateName: template?.name ?? null,
    categoryName: category?.name ?? null,
    verificationUrl: `${webBaseUrl(config)}/verify/${agreement.public_id}`,
    createdAt: version.created_at,
    finalizedAt: version.finalized_at,
    signatures,
    fieldLabels,
  };
}

/** Render a version to the canonical HTML document. */
export async function buildDocumentHtml(
  db: Queryable,
  config: Config,
  agreement: RenderableAgreement,
  version: RenderableVersion,
): Promise<string> {
  return renderDocumentHtml(await buildRenderDocumentInput(db, config, agreement, version));
}
