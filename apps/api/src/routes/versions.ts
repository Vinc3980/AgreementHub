/**
 * /versions routes: create a new immutable version, retrieve, compare.
 */
import type { FastifyInstance } from 'fastify';
import { createVersionRequestSchema } from '@agreementhub/contracts';
import { AppError } from '@agreementhub/domain';
import { authenticate } from '../plugins/auth.js';
import { withTransaction } from '../db.js';
import { getAgreement } from '../services/agreements.js';
import { auditActor, type ActorContext } from '../services/context.js';
import { requireAccess, requireEdit } from '../services/access.js';
import { recordAudit } from '../services/audit.js';
import {
  buildContent,
  diffVersions,
  getVersion,
  insertVersion,
} from '../services/versions.js';
import { one } from '../db.js';
import type { TemplateRow } from '../services/types.js';

function actorOf(request: { actor?: ActorContext }): ActorContext {
  if (!request.actor) throw AppError.unauthorized();
  return request.actor;
}

export function registerVersionRoutes(app: FastifyInstance): void {
  const { ahDb: db } = app;

  app.post('/versions', { preHandler: authenticate }, async (request, reply) => {
    const ctx = actorOf(request);
    const input = createVersionRequestSchema.parse(request.body);
    const { agreementId } = request.body as { agreementId: string };

    const version = await withTransaction(db, async (tx) => {
      const access = await requireAccess(tx, ctx.userId, ctx.email, agreementId);

      if (['AWAITING_SIGNATURES', 'ACTIVE', 'EXPIRING', 'EXPIRED'].includes(access.agreement.status)) {
        throw AppError.conflict(
          'VERSION_LOCKED',
          `New versions cannot be created while the agreement is ${access.agreement.status}.`,
        );
      }
      requireEdit(access);

      const template = await one<TemplateRow>(
        tx,
        `SELECT id, name FROM agreement_templates WHERE id = $1`,
        [access.agreement.template_id],
      );
      const content = await buildContent(
        tx,
        access.agreement.id,
        access.agreement.public_id,
        access.agreement.title,
        template?.name ?? '',
      );

      const created = await insertVersion(tx, {
        agreementId,
        content,
        changeSummary: input.changeSummary,
        createdBy: ctx.userId,
      });

      await recordAudit(tx, {
        agreementId,
        orgId: access.agreement.org_id,
        eventType: 'VERSION_CREATED',
        actor: auditActor(ctx),
        metadata: {
          publicId: access.agreement.public_id,
          versionNumber: created.version_number,
          previousVersionId: created.previous_version_id,
          documentHash: created.document_hash,
          changeSummary: input.changeSummary,
        },
        requestId: ctx.requestId,
      });

      return created;
    });

    return reply.status(201).send({
      version: {
        id: version.id,
        versionNumber: version.version_number,
        status: version.status,
        changeSummary: version.change_summary,
        documentHash: version.document_hash,
        previousVersionId: version.previous_version_id,
        createdAt: version.created_at.toISOString(),
      },
    });
  });

  app.get('/versions/:id', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    const version = await getVersion(db, id);
    if (!version) throw AppError.notFound('Version not found.');
    // Visibility check via parent agreement.
    await getAgreement(db, ctx, version.agreement_id);
    return {
      version: {
        id: version.id,
        agreementId: version.agreement_id,
        versionNumber: version.version_number,
        status: version.status,
        changeSummary: version.change_summary,
        documentHash: version.document_hash,
        previousVersionId: version.previous_version_id,
        createdAt: version.created_at.toISOString(),
        finalizedAt: version.finalized_at?.toISOString() ?? null,
        content: version.content,
      },
    };
  });

  app.get('/versions/:id/diff/:otherId', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id, otherId } = request.params as { id: string; otherId: string };
    const a = await getVersion(db, id);
    const b = await getVersion(db, otherId);
    if (!a || !b) throw AppError.notFound('Version not found.');
    if (a.agreement_id !== b.agreement_id) {
      throw AppError.badRequest('CROSS_AGREEMENT_DIFF', 'Versions belong to different agreements.');
    }
    await getAgreement(db, ctx, a.agreement_id);
    return { diff: diffVersions(a, b) };
  });
}
