/**
 * /ai routes, the Agreement Assistant.
 *
 * Every endpoint is AUTHENTICATED and READ-ONLY with respect to agreement
 * data: the assistant never creates, edits, or finalizes anything. Applying
 * extracted suggestions is the user's own PATCH request (provenance
 * `AI_SUGGESTED_CONFIRMED`), so confirmation is explicit and audited, and
 * finalized agreements cannot be altered through the assistant.
 *
 * Provider keys/config stay server-side; responses always include the fixed
 * disclaimer. Logging is metadata-only (see services/aiAssistant.ts).
 */
import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import { AppError } from '@agreementhub/domain';
import {
  aiExplainRequestSchema,
  aiExtractRequestSchema,
} from '@agreementhub/contracts';
import { createAiProvider, type AiProvider } from '../ai/index.js';
import { authenticate } from '../plugins/auth.js';
import { requireAccess } from '../services/access.js';
import type { ActorContext } from '../services/context.js';
import {
  explainClause,
  extractFields,
  reviewAgreement,
  suggestQuestions,
  summarizeAgreement,
  type AssistantLogger,
} from '../services/aiAssistant.js';

function actorOf(request: { actor?: ActorContext }): ActorContext {
  if (!request.actor) throw AppError.unauthorized();
  return request.actor;
}

/** Metadata-only logger adapter: pino instance → assistant logger shape. */
function loggerOf(log: FastifyBaseLogger): AssistantLogger {
  return {
    info: (obj, msg) => log.info(obj, msg),
    warn: (obj, msg) => log.warn(obj, msg),
  };
}

export function registerAiRoutes(app: FastifyInstance): void {
  const { ahDb: db } = app;
  // One provider instance per app (constructed from server-side config only).
  const provider: AiProvider = createAiProvider(app.ahConfig);

  /* --------------------------- feature 1 -------------------------------- */
  app.post('/ai/extract', { preHandler: authenticate }, async (request) => {
    actorOf(request);
    const input = aiExtractRequestSchema.parse(request.body ?? {});
    return extractFields(db, provider, loggerOf(request.log), input);
  });

  /* --------------------------- feature 2 -------------------------------- */
  app.post('/agreements/:id/ai/review', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    await requireAccess(db, ctx.userId, ctx.email, id);
    return reviewAgreement(db, provider, loggerOf(request.log), id);
  });

  /* --------------------------- feature 3 -------------------------------- */
  app.post('/agreements/:id/ai/explain', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    await requireAccess(db, ctx.userId, ctx.email, id);
    const body = aiExplainRequestSchema.parse(request.body ?? {});
    if (body.agreementId !== id) {
      throw AppError.badRequest('AGREEMENT_MISMATCH', 'agreementId does not match the URL.');
    }
    return explainClause(db, provider, loggerOf(request.log), body);
  });

  /* --------------------------- feature 4 -------------------------------- */
  app.post('/agreements/:id/ai/summary', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    await requireAccess(db, ctx.userId, ctx.email, id);
    return summarizeAgreement(db, provider, loggerOf(request.log), id);
  });

  /* --------------------------- feature 5 -------------------------------- */
  app.post('/agreements/:id/ai/questions', { preHandler: authenticate }, async (request) => {
    const ctx = actorOf(request);
    const { id } = request.params as { id: string };
    await requireAccess(db, ctx.userId, ctx.email, id);
    return suggestQuestions(db, provider, loggerOf(request.log), id);
  });
}
