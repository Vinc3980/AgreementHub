/**
 * Fastify application factory: logging, request IDs, rate limiting, cookies,
 * error handling, authentication plugin, and domain route registration.
 * Exported separately from main.ts so tests can build an app without
 * binding a port.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config.js';
import { createPool, type Db } from './db.js';
import { registerErrorHandler } from './plugins/errors.js';
import { registerAuth } from './plugins/auth.js';
import { registerSecurity } from './plugins/security.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerAgreementRoutes } from './routes/agreements.js';
import { registerVersionRoutes } from './routes/versions.js';
import { registerPartyRoutes } from './routes/parties.js';
import { registerCommentRoutes } from './routes/comments.js';
import { registerProposalRoutes } from './routes/proposals.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerSignatureRoutes } from './routes/signatures.js';
import { registerVerificationRoutes } from './routes/verification.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerUserRoutes } from './routes/users.js';
import { registerObligationRoutes } from './routes/obligations.js';
import { closePdfBrowser } from './services/pdf.js';

export interface BuildAppOptions {
  config: Config;
  /** Provide an existing pool (tests reuse one pool per run). */
  db?: Db;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const db = options.db ?? createPool(config);

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never log credentials, session material, signature payloads, or the
      // assistant's private inputs (agreement descriptions / clause text).
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.description',
          'req.body.text',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
    },
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 1_048_576, // 1 MiB JSON bodies (uploads use multipart separately)
    trustProxy: config.TRUST_PROXY,
  });

  await app.register(cookie, {});
  // Avatars are the only multipart surface. Enforce the 2 MB cap at the
  // parser so an oversized body never reaches the image pipeline.
  await app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 4 },
  });

  registerSecurity(app, config);

  if (config.RATE_LIMIT_MAX > 0) {
    await app.register(rateLimit, {
      global: true,
      max: config.RATE_LIMIT_MAX,
      timeWindow: config.RATE_LIMIT_WINDOW_MS,
      keyGenerator: (req) => req.ip,
      errorResponseBuilder: () => ({
        type: 'https://agreementhub.local/problems/rate_limited',
        title: 'Too many requests',
        status: 429,
        detail: 'Too many requests. Please retry later.',
        code: 'RATE_LIMITED',
        requestId: '',
      }),
    });
  }

  registerErrorHandler(app);
  registerAuth(app, { db, config });

  // Health/readiness (no auth, no user data).
  app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  // Domain routes under /api/v1.
  await app.register(
    async (api) => {
      registerAuthRoutes(api);
      registerTemplateRoutes(api);
      registerAgreementRoutes(api);
      registerVersionRoutes(api);
      registerPartyRoutes(api);
      registerCommentRoutes(api);
      registerProposalRoutes(api);
      registerApprovalRoutes(api);
      registerSignatureRoutes(api);
      registerVerificationRoutes(api);
      registerNotificationRoutes(api);
      registerDashboardRoutes(api);
      registerAdminRoutes(api);
      registerDocumentRoutes(api);
      registerAiRoutes(api);
      registerUserRoutes(api);
      registerObligationRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  app.addHook('onClose', async () => {
    await closePdfBrowser();
    if (!options.db) await db.end();
  });

  return app;
}
