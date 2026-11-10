/**
 * Authentication middleware: resolves session token from the Authorization
 * header (API clients) or the session cookie (browsers), attaches the actor
 * context used by every service call and audit event.
 */
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { AppError } from '@agreementhub/domain';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { resolveSession } from '../services/identity.js';
import type { ActorContext } from '../services/context.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after authentication succeeds. */
    actor?: ActorContext;
    sessionId?: string;
  }
  interface FastifyInstance {
    ahDb: Db;
    ahConfig: Config;
    requireAuth: preHandlerHookHandler;
    optionalAuth: preHandlerHookHandler;
  }
}

export interface AuthPluginOptions {
  db: Db;
  config: Config;
}

export function extractToken(request: FastifyRequest, cookieName: string): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
  }
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> })
    .cookies;
  const cookieValue = cookies?.[cookieName];
  return cookieValue ?? null;
}

/** Core resolution shared by the required and optional variants. */
async function attachActor(request: FastifyRequest): Promise<void> {
  const app: FastifyInstance = request.server;
  const { ahDb: db, ahConfig: config } = app;
  const token = extractToken(request, config.SESSION_COOKIE_NAME);
  if (!token) throw AppError.unauthorized();

  const session = await resolveSession(db, token);
  if (!session) throw AppError.unauthorized('Session is invalid or expired.');

  request.actor = {
    userId: session.user.id,
    email: session.user.email,
    displayName: session.user.display_name,
    requestId: String(request.id),
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
  request.sessionId = session.sessionId;
}

/** preHandler: rejects requests without a valid session. */
export const authenticate: preHandlerHookHandler = async (request) => {
  await attachActor(request);
};

/** preHandler: populates actor when a valid session exists; allows anonymous. */
export const maybeAuthenticate: preHandlerHookHandler = async (request) => {
  try {
    await attachActor(request);
  } catch {
    // anonymous access allowed on this route
  }
};

export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): void {
  app.decorate('ahDb', options.db);
  app.decorate('ahConfig', options.config);
  app.decorate('requireAuth', authenticate);
  app.decorate('optionalAuth', maybeAuthenticate);
}
