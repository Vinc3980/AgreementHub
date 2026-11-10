/**
 * Minimal typed API client for the AgreementHub backend.
 *
 * All calls go through the Next.js rewrite proxy (/api/* → Fastify), so the
 * browser sees a single origin and the httpOnly session cookie is sent
 * automatically. Errors are normalized to ApiError with the backend's
 * machine-readable `code`.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors?: unknown,
    readonly requestId?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level validation errors from zod, if any. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    const errs = this.errors;
    if (Array.isArray(errs)) {
      for (const e of errs) {
        if (e && typeof e === 'object' && 'path' in e && 'message' in e) {
          const path = String((e as { path: unknown }).path);
          if (!out[path]) out[path] = String((e as { message: unknown }).message);
        }
      }
    }
    return out;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

const BASE = '/api/v1';

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET');
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: options.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection.');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }

  if (!res.ok) {
    const problem = (data ?? {}) as {
      detail?: string;
      title?: string;
      code?: string;
      errors?: unknown;
      requestId?: string;
      retryAfterSeconds?: number;
    };
    throw new ApiError(
      res.status,
      problem.code ?? 'HTTP_ERROR',
      problem.detail ?? problem.title ?? `Request failed (${res.status}).`,
      problem.errors,
      problem.requestId,
      typeof problem.retryAfterSeconds === 'number' ? problem.retryAfterSeconds : undefined,
    );
  }
  return data as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/**
 * Multipart upload with real progress. XMLHttpRequest is used because fetch
 * still cannot report upload progress in browsers.
 */
export function upload<T>(
  path: string,
  form: FormData,
  onProgress?: (fraction: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}${path}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(event.loaded / event.total);
      }
    };
    xhr.onerror = () => {
      reject(new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection.'));
    };
    xhr.onload = () => {
      let data: unknown;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
        return;
      }
      const problem = (data ?? {}) as {
        detail?: string;
        title?: string;
        code?: string;
        errors?: unknown;
        requestId?: string;
        retryAfterSeconds?: number;
      };
      reject(
        new ApiError(
          xhr.status,
          problem.code ?? 'HTTP_ERROR',
          problem.detail ?? problem.title ?? `Request failed (${xhr.status}).`,
          problem.errors,
          problem.requestId,
          typeof problem.retryAfterSeconds === 'number' ? problem.retryAfterSeconds : undefined,
        ),
      );
    };
    xhr.send(form);
  });
}

/** `true` when the error means "no/invalid session", used for global handling. */
export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.code === 'UNAUTHORIZED');
}
