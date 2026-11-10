/**
 * Typed environment configuration. Fails fast on malformed values.
 * Loads .env (if present) via Node's built-in env file support.
 */
import { z } from 'zod';

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env from cwd and/or the monorepo root (cwd when running workspace
// scripts is apps/api, so the root .env would otherwise be missed).
const __configDir = dirname(fileURLToPath(import.meta.url));
for (const envPath of [
  resolve(process.cwd(), '.env'),
  resolve(__configDir, '../../../.env'),
]) {
  try {
    if (existsSync(envPath)) process.loadEnvFile(envPath);
  } catch {
    // .env optional, process environment may be provided externally
  }
}

/** Accepts "true"/"false" strings (env), booleans (tests), and 1/0. */
const booleanish = (defaultValue: boolean) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') return defaultValue;
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      const s = String(value).trim().toLowerCase();
      return s === 'true' || s === '1' || s === 'yes';
    },
    z.boolean(),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('127.0.0.1'),
    /**
     * API/public base URL (e.g. the API origin). Kept for backward compatibility.
     * User-facing links (verification, reset, invitations, QR targets) use WEB_BASE_URL.
     */
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
    /** Browser origin of the web app (canonical base for user-facing links). */
    WEB_BASE_URL: z.string().url().optional(),
    /** Browser origin of the web app (same allowed origin for CORS/CSRF). */
    WEB_ORIGIN: z.string().url().default('http://localhost:3001'),
    /** Comma-separated extra origins allowed to call the API (CORS/CSRF). */
    CORS_ORIGINS: z.string().default(''),
    /** Never trust X-Forwarded-* unless a reverse proxy is actually deployed. */
    TRUST_PROXY: booleanish(false),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(168),
    SESSION_COOKIE_NAME: z.string().default('ah_session'),
    AGREEMENT_ID_PREFIX: z.string().regex(/^[A-Z]{2,4}-[A-Z]{2,4}$/).default('AGR-GH'),
    RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(300),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /* AI assistant (server-side only; keys never reach the web app). */
    AI_PROVIDER: z.enum(['rules', 'openai']).default('rules'),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    AI_MODEL: z.string().min(1).default('gpt-4o-mini'),
    /* Document generation: HTML → PDF → hash → storage (SPEC FR-13 document
     * pipeline). STORAGE_DIR is server-side only, never exposed via the API. */
    STORAGE_DIR: z.string().min(1).default('./storage'),
    PDF_GENERATION: z.enum(['on', 'off']).default('on'),
    PDF_BROWSER_PATH: z.string().optional(),
    /**
     * Email delivery. Preferred names: MAIL_PROVIDER/MAIL_FROM. Legacy EMAIL_*
     * names are accepted for backward compatibility.
     * console logs (development), smtp sends via SMTP, resend uses the HTTP API,
     * memory captures for tests, disabled drops.
     */
    MAIL_PROVIDER: z.enum(['console', 'smtp', 'resend', 'memory', 'disabled']).optional(),
    MAIL_FROM: z.string().min(1).optional(),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_TRANSPORT: z.enum(['console', 'smtp', 'memory', 'disabled']).default('console'),
    EMAIL_FROM: z.string().default('AgreementHub <no-reply@agreementhub.local>'),
    EMAIL_SMTP_HOST: z.string().optional(),
    EMAIL_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_SECURE: booleanish(false),
    EMAIL_SMTP_USER: z.string().optional(),
    EMAIL_SMTP_PASS: z.string().optional(),
    EMAIL_SMTP_SECURE: booleanish(false),
    EMAIL_RETRY_MAX: z.coerce.number().int().min(1).max(50).default(5),
    EMAIL_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
    /* Background scheduler (expiry sweep, reminders, outbox delivery).
     * 0 disables the timer (tests call the sweep functions directly). */
    SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(0).default(300_000),
    REMINDER_SIGNATURE_INTERVAL_DAYS: z.coerce.number().int().min(1).default(3),
    REMINDER_SIGNATURE_MAX: z.coerce.number().int().min(1).max(20).default(5),
    /* Days-before-expiry reminder ladder, comma separated. */
    EXPIRY_WARN_DAYS: z.string().default('30,7,1'),
    /* Emails that automatically receive platform-admin privileges at
     * registration. Prefer granting the DB flag directly in production. */
    PLATFORM_ADMIN_EMAILS: z.string().default(''),
    /* Initial market/localization defaults (configurable for future expansion;
     * Ghana-first). */
    DEFAULT_COUNTRY_CODE: z.string().length(2).default('GH'),
    DEFAULT_LOCALE: z.string().min(2).default('en-GH'),
    DEFAULT_TIMEZONE: z.string().min(1).default('Africa/Accra'),
    DEFAULT_CURRENCY: z.string().min(3).max(3).default('GHS'),
  })
  .superRefine((env, ctx) => {
    const provider = env.MAIL_PROVIDER ?? env.EMAIL_TRANSPORT ?? (env.NODE_ENV === 'development' ? 'console' : undefined);
    if (env.NODE_ENV === 'production') {
      if (!provider || provider === 'console' || provider === 'disabled') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MAIL_PROVIDER'],
          message: 'MAIL_PROVIDER (or EMAIL_TRANSPORT) must be set to a real provider (smtp or resend) in production.',
        });
      }
      if (provider === 'smtp' && !(env.SMTP_HOST ?? env.EMAIL_SMTP_HOST)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_HOST'],
          message: 'SMTP_HOST (or EMAIL_SMTP_HOST) is required when MAIL_PROVIDER=smtp in production.',
        });
      }
      if (provider === 'resend' && !env.RESEND_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RESEND_API_KEY'],
          message: 'RESEND_API_KEY is required when MAIL_PROVIDER=resend in production.',
        });
      }
    }
  });

export type Config = z.infer<typeof envSchema>;

export type MailProvider = 'console' | 'smtp' | 'resend' | 'memory' | 'disabled';

export function loadConfig(overrides: Partial<Config> = {}): Config {
  // Overrides (tests) merge over process.env so they can also satisfy
  // otherwise-required fields like DATABASE_URL.
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return { ...parsed.data, ...overrides };
}

/** Canonical mail provider (MAIL_PROVIDER preferred, EMAIL_TRANSPORT fallback). */
export function mailProvider(config: Config): MailProvider {
  return (config.MAIL_PROVIDER ?? config.EMAIL_TRANSPORT ?? 'console') as MailProvider;
}

export function mailFrom(config: Config): string {
  return config.MAIL_FROM ?? config.EMAIL_FROM;
}

/** Web origin for user-facing links (verification, reset, invitations, QR targets). */
export function webBaseUrl(config: Config): string {
  return (config.WEB_BASE_URL ?? config.WEB_ORIGIN).replace(/\/$/, '');
}

/** Origins allowed to call the API from a browser (CORS / CSRF allowlist). */
export function allowedOrigins(config: Config): string[] {
  const list = [config.WEB_ORIGIN, webBaseUrl(config), config.PUBLIC_BASE_URL];
  for (const origin of config.CORS_ORIGINS.split(',')) {
    const trimmed = origin.trim();
    if (trimmed) list.push(trimmed);
  }
  return [...new Set(list)];
}

/** Expiry warning ladder (descending), sanitized to positive day counts. */
export function expiryWarnDays(config: Config): number[] {
  return config.EXPIRY_WARN_DAYS.split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d > 0)
    .sort((a, b) => b - a);
}
