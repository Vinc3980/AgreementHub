/**
 * Consistent error responses: RFC 7807 problem+json with a stable `code`.
 * Never leaks internals (stack traces, SQL, password hashes, tokens).
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, InvalidTransitionError } from '@agreementhub/domain';
import { ZodError } from 'zod';

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  requestId: string;
  errors?: unknown;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = String(request.id);

    if (error instanceof AppError) {
      const details = error.details as Record<string, unknown> | undefined;
      const body: ProblemBody & { retryAfterSeconds?: number } = {
        type: `https://agreementhub.local/problems/${error.code.toLowerCase()}`,
        title: error.statusCode >= 500 ? 'Server error' : 'Request error',
        status: error.statusCode,
        detail: error.message,
        code: error.code,
        requestId,
      };
      if (details?.retryAfterSeconds !== undefined) {
        body.retryAfterSeconds = Number(details.retryAfterSeconds);
      }
      if (error.details !== undefined) body.errors = error.details;
      if (error.statusCode >= 500) request.log.error({ err: error, code: error.code }, 'app error');
      else request.log.info({ code: error.code, status: error.statusCode }, 'handled error');
      return reply.status(error.statusCode).send(body);
    }

    if (error instanceof InvalidTransitionError) {
      return reply.status(409).send({
        type: 'https://agreementhub.local/problems/invalid_transition',
        title: 'Request error',
        status: 409,
        detail: error.message,
        code: error.code,
        requestId,
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        type: 'https://agreementhub.local/problems/validation_failed',
        title: 'Request error',
        status: 400,
        detail: 'Request validation failed.',
        code: 'VALIDATION_FAILED',
        requestId,
        errors: error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      });
    }

    const fastifyError = error as FastifyError & { code?: string };
    // PostgreSQL constraint violations surface as conflicts / bad requests,
    // never as 500s with SQL details.
    if (fastifyError.code === '23505') {
      return reply.status(409).send({
        type: 'https://agreementhub.local/problems/conflict',
        title: 'Conflict',
        status: 409,
        detail: 'A conflicting record already exists.',
        code: 'CONFLICT',
        requestId,
      });
    }
    if (
      fastifyError.code === '23503' ||
      fastifyError.code === '23502' ||
      fastifyError.code === '23514'
    ) {
      return reply.status(400).send({
        type: 'https://agreementhub.local/problems/bad_request',
        title: 'Request error',
        status: 400,
        detail: 'Request violates a data constraint.',
        code: 'CONSTRAINT_VIOLATION',
        requestId,
      });
    }
    if (fastifyError.statusCode === 429) {
      return reply.status(429).send({
        type: 'https://agreementhub.local/problems/rate_limited',
        title: 'Too many requests',
        status: 429,
        detail: 'Too many requests. Please retry later.',
        code: 'RATE_LIMITED',
        requestId,
      });
    }
    if (fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
      return reply.status(fastifyError.statusCode).send({
        type: 'https://agreementhub.local/problems/bad_request',
        title: 'Request error',
        status: fastifyError.statusCode,
        detail: fastifyError.message || 'Bad request.',
        code: 'BAD_REQUEST',
        requestId,
      });
    }

    // Unexpected: log full details, return a generic body (no internals leaked).
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      type: 'https://agreementhub.local/problems/internal_error',
      title: 'Server error',
      status: 500,
      detail: 'Internal server error.',
      code: 'INTERNAL_ERROR',
      requestId,
    });
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.status(404).send({
      type: 'https://agreementhub.local/problems/not_found',
      title: 'Not found',
      status: 404,
      detail: `Route ${request.method} ${request.url} not found.`,
      code: 'NOT_FOUND',
      requestId: String(request.id),
    });
  });
}
