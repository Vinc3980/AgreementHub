/**
 * Canonical application error. Every module throws these; the API error
 * handler maps them to RFC 7807 problem+json responses with a stable `code`.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(code: string, message: string, details?: unknown): AppError {
    return new AppError(400, code, message, details);
  }

  static unauthorized(message = 'Authentication required.'): AppError {
    return new AppError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'You do not have permission to perform this action.', details?: unknown): AppError {
    return new AppError(403, 'FORBIDDEN', message, details);
  }

  /** Used for both "not found" and "not visible to you" (no IDOR leaks). */
  static notFound(message = 'Resource not found.'): AppError {
    return new AppError(404, 'NOT_FOUND', message);
  }

  static conflict(code: string, message: string, details?: unknown): AppError {
    return new AppError(409, code, message, details);
  }

  static tooMany(
    message = 'Too many requests. Please retry later.',
    details?: { retryAfterSeconds?: number },
  ): AppError {
    return new AppError(429, 'RATE_LIMITED', message, details);
  }

  static internal(message = 'Internal server error.'): AppError {
    return new AppError(500, 'INTERNAL_ERROR', message);
  }
}
