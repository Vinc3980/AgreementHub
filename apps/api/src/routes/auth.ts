/**
 * /auth and /users routes: register, login, logout, session, profile,
 * password reset/change, session management.
 * Rate-limited harder than the rest of the API (credential endpoints).
 */
import type { FastifyInstance } from 'fastify';
import {
  changePasswordRequestSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  notificationPreferencesSchema,
  registerRequestSchema,
  resetPasswordRequestSchema,
  updateProfileRequestSchema,
  verifyEmailRequestSchema,
} from '@agreementhub/contracts';
import { AppError } from '@agreementhub/domain';
import { authenticate, extractToken } from '../plugins/auth.js';
import { exec } from '../db.js';
import {
  listUserOrgs,
  login,
  register,
  revokeAllSessions,
  revokeSession,
} from '../services/identity.js';
import {
  changePassword,
  createPasswordReset,
  getNotificationPreferences,
  getProfile,
  listSessions,
  publicProfile,
  resetPassword,
  revokeSessionById,
  updateNotificationPreferences,
  updateProfile,
} from '../services/accounts.js';
import {
  createEmailVerificationToken,
  resendCooldownRemaining,
  verifyEmail,
} from '../services/emailVerification.js';
import * as outbox from '../services/outbox.js';
import { mailProvider, webBaseUrl } from '../config.js';

export function registerAuthRoutes(app: FastifyInstance): void {
  const { ahDb: db, ahConfig: config } = app;

  const authRateLimit = {
    rateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS },
  };

  app.post(
    '/auth/register',
    { config: authRateLimit },
    async (request, reply) => {
      const input = registerRequestSchema.parse(request.body);
      const result = await register(db, input, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        ttlHours: config.SESSION_TTL_HOURS,
      });

      // Bootstrap platform administrators from an allowlist (env-controlled).
      const adminEmails = config.PLATFORM_ADMIN_EMAILS.split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      if (adminEmails.includes(result.user.email.toLowerCase())) {
        await exec(db, `UPDATE users SET is_platform_admin = true WHERE id = $1`, [result.user.id]);
      }

      // Issue and send the verification email. Registration must not be blocked
      // if mail delivery setup fails; the user can resend from Settings.
      let emailVerificationSent = false;
      try {
        const verification = await createEmailVerificationToken(db, result.user.id, request.ip ?? null);
        await outbox.enqueueEmail(db, {
          to: result.user.email,
          template: 'EMAIL_VERIFICATION',
          payload: { token: verification.rawToken, expiresAt: verification.expiresAt.toISOString() },
          dedupeKey: `verify-email:${result.user.id}:${verification.expiresAt.getTime()}`,
        });
        emailVerificationSent = true;
      } catch (err) {
        request.log.error({ err, userId: result.user.id }, 'failed to send verification email after registration');
      }

      setSessionCookie(reply, config, result.token, result.expiresAt);
      const profile = await getProfile(db, result.user.id);
      if (!profile) throw AppError.internal('Failed to load the new account.');
      return reply.status(201).send({
        user: publicProfile(profile),
        token: result.token,
        organizations: await listUserOrgs(db, result.user.id),
        emailVerificationSent,
      });
    },
  );

  app.post(
    '/auth/login',
    { config: authRateLimit },
    async (request, reply) => {
      const input = loginRequestSchema.parse(request.body);
      const result = await login(db, input, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        ttlHours: config.SESSION_TTL_HOURS,
      });
      setSessionCookie(reply, config, result.token, result.expiresAt);
      const profile = await getProfile(db, result.user.id);
      if (!profile) throw AppError.internal('Failed to load the account.');
      return reply.send({
        user: publicProfile(profile),
        token: result.token,
        organizations: await listUserOrgs(db, result.user.id),
      });
    },
  );

  /* ------------------------- email verification ------------------------ */

  async function requestVerification(request: any, reply: any) {
    const actor = request.actor!;
    const profile = await getProfile(db, actor.userId);
    if (!profile) throw AppError.unauthorized();
    if (profile.email_verified_at) {
      return reply.send({ ok: true, sent: false, alreadyVerified: true });
    }

    // Throttle resends per account (the global credential limiter also applies).
    const cooldown = await resendCooldownRemaining(db, actor.userId);
    if (cooldown > 0) {
      throw AppError.tooMany(
        `Please wait ${cooldown} second(s) before requesting another verification email.`,
        { retryAfterSeconds: cooldown },
      );
    }

    const verification = await createEmailVerificationToken(db, actor.userId, request.ip ?? null);
    await outbox.enqueueEmail(db, {
      to: profile.email,
      template: 'EMAIL_VERIFICATION',
      payload: { token: verification.rawToken, expiresAt: verification.expiresAt.toISOString() },
      dedupeKey: `verify-email:${actor.userId}:${verification.expiresAt.getTime()}`,
    });
    const body: Record<string, unknown> = { ok: true, sent: true, alreadyVerified: false };
    // Dev/test convenience only: never expose raw tokens in production responses.
    if (config.NODE_ENV !== 'production') {
      body.devVerifyUrl = `${webBaseUrl(config)}/verify-email?token=${encodeURIComponent(verification.rawToken)}`;
      body.devMode = mailProvider(config) === 'console';
    }
    return reply.send(body);
  }

  app.post(
    '/auth/verify-email/request',
    { preHandler: authenticate, config: authRateLimit },
    requestVerification,
  );

  // Backward-compatible alias for older clients.
  app.post(
    '/auth/verification-email/resend',
    { preHandler: authenticate, config: authRateLimit },
    requestVerification,
  );

  app.post(
    '/auth/verify-email/confirm',
    { config: authRateLimit },
    async (request) => {
      const input = verifyEmailRequestSchema.parse(request.body);
      await verifyEmail(db, input.token);
      return { ok: true, verified: true };
    },
  );

  // Backward-compatible confirm route.
  app.post(
    '/auth/verify-email',
    { config: authRateLimit },
    async (request) => {
      const input = verifyEmailRequestSchema.parse(request.body);
      await verifyEmail(db, input.token);
      return { ok: true, verified: true };
    },
  );

  app.post('/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    const token = extractToken(request, config.SESSION_COOKIE_NAME);
    if (token) await revokeSession(db, token);
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
    return reply.status(204).send();
  });

  app.post('/auth/logout-all', { preHandler: authenticate }, async (request, reply) => {
    if (request.actor) await revokeAllSessions(db, request.actor.userId);
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
    return reply.status(204).send();
  });

  /* --------------------------- password reset -------------------------- */

  app.post('/auth/forgot-password', { config: authRateLimit }, async (request) => {
    const input = forgotPasswordRequestSchema.parse(request.body);
    const result = await createPasswordReset(db, input.email, request.ip ?? null);

    // Uniform response shape in production: never reveals whether the account exists.
    if (result) {
      await outbox.enqueueEmail(db, {
        to: input.email,
        template: 'PASSWORD_RESET',
        payload: { token: result.token, expiresAt: result.expiresAt.toISOString() },
      });
    }

    const body: Record<string, unknown> = { ok: true };
    // Dev/test convenience only: expose a usable reset link when the account exists.
    // Never expose raw tokens in production responses.
    if (result && config.NODE_ENV !== 'production') {
      body.devResetUrl = `${webBaseUrl(config)}/reset-password?token=${encodeURIComponent(result.token)}`;
      body.devResetToken = result.token;
      body.devMode = mailProvider(config) === 'console';
    }
    return body;
  });

  app.post('/auth/reset-password', { config: authRateLimit }, async (request, reply) => {
    const input = resetPasswordRequestSchema.parse(request.body);
    await resetPassword(db, input.token, input.password);
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  app.post('/auth/change-password', { preHandler: authenticate, config: authRateLimit }, async (request) => {
    const actor = request.actor!;
    const input = changePasswordRequestSchema.parse(request.body);
    await changePassword(db, actor.userId, input.currentPassword, input.newPassword, request.sessionId ?? null);
    return { ok: true };
  });

  /* -------------------------- session management ----------------------- */

  app.get('/auth/sessions', { preHandler: authenticate }, async (request) => {
    const actor = request.actor!;
    const sessions = await listSessions(db, actor.userId, request.sessionId ?? null);
    return { sessions };
  });

  app.delete('/auth/sessions/:id', { preHandler: authenticate }, async (request, reply) => {
    const actor = request.actor!;
    const { id } = request.params as { id: string };
    await revokeSessionById(db, actor.userId, id);
    if (id === request.sessionId) {
      reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
    }
    return reply.status(204).send();
  });

  /* ------------------------------- profile ----------------------------- */

  app.get('/auth/session', { preHandler: authenticate }, async (request) => {
    const actor = request.actor!;
    const user = await getProfile(db, actor.userId);
    if (!user) throw AppError.unauthorized();
    return {
      user: publicProfile(user),
      organizations: await listUserOrgs(db, actor.userId),
      requestId: String(request.id),
    };
  });

  app.get('/users/me', { preHandler: authenticate }, async (request) => {
    const actor = request.actor!;
    const user = await getProfile(db, actor.userId);
    if (!user) throw AppError.unauthorized();
    return { user: publicProfile(user), organizations: await listUserOrgs(db, actor.userId) };
  });

  app.patch('/users/me', { preHandler: authenticate }, async (request) => {
    const actor = request.actor!;
    const input = updateProfileRequestSchema.parse(request.body);
    const user = await updateProfile(db, actor.userId, input);
    return {
      user: publicProfile(user),
      organizations: await listUserOrgs(db, actor.userId),
    };
  });

  /* --------------------- notification preferences ------------------- */

  app.get('/users/me/notification-preferences', { preHandler: authenticate }, async (request) => {
    const actor = request.actor!;
    return { preferences: await getNotificationPreferences(db, actor.userId) };
  });

  app.patch('/users/me/notification-preferences', { preHandler: authenticate }, async (request) => {
    const actor = request.actor!;
    const input = notificationPreferencesSchema.parse(request.body ?? {});
    return { preferences: await updateNotificationPreferences(db, actor.userId, input) };
  });
}

function setSessionCookie(
  reply: { setCookie: (name: string, value: string, opts: Record<string, unknown>) => void },
  config: { SESSION_COOKIE_NAME: string; NODE_ENV: string },
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(config.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}
