/**
 * Security middleware (audit Phase 5): HTTP hardening headers, an explicit
 * CORS allowlist, and CSRF protection for cookie-authenticated mutations.
 *
 * This replaces the previous incomplete plugin that was never registered and
 * depended on an uninstalled CORS package.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '@agreementhub/domain';
import { allowedOrigins, type Config } from '../config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function registerSecurity(app: FastifyInstance, config: Config): void {
  const origins = new Set(allowedOrigins(config));

  // CORS + preflight. Same-origin browser traffic (the normal case, via the
  // Next.js proxy) needs no CORS headers; only explicitly allowed origins do.
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && origins.has(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-credentials', 'true');
      reply.header('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      reply.header('access-control-allow-headers', 'content-type,authorization');
      reply.header('access-control-max-age', '600');
    }
    if (request.method === 'OPTIONS') {
      if (origin && origins.has(origin)) {
        return reply.status(204).send();
      }
      return reply.status(403).send({
        type: 'https://agreementhub.local/problems/cors_denied',
        title: 'Forbidden',
        status: 403,
        detail: 'Origin is not allowed to call this API.',
        code: 'CORS_DENIED',
        requestId: String(request.id),
      });
    }
    return undefined;
  });

  // CSRF: an authenticated cookie session may only mutate state from an
  // allowed browser origin. Bearer clients (API/CLI) are not CSRF-able.
  app.addHook('preHandler', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const cookies = (request as typeof request & { cookies?: Record<string, string | undefined> })
      .cookies;
    const hasSessionCookie = Boolean(cookies?.[config.SESSION_COOKIE_NAME]);
    if (!hasSessionCookie) return;
    if (request.headers.authorization?.startsWith('Bearer ')) return;

    const origin =
      originOf(request.headers.origin) ?? originOf(request.headers.referer);
    // Same-origin navigations may omit Origin (older browsers); only reject a
    // *present but disallowed* origin. SameSite=Strict remains the second layer.
    if (origin && !origins.has(origin)) {
      throw AppError.forbidden('Cross-site request blocked. Refresh and try again.');
    }
  });

  // Secure response headers for every response (API JSON and file streams).
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', 'geolocation=(), camera=(), microphone=()');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header(
      'content-security-policy',
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    if (config.NODE_ENV === 'production') {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });
}
