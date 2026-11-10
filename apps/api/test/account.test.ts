/**
 * Account endpoints used by the frontend: onboarding profile, forgot/reset
 * password, change password, and session management.
 */
import { describe, expect, it } from 'vitest';
import {
  del,
  get,
  latestEmailFor,
  patch,
  post,
  registerUser,
  uniqueEmail,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

describe('onboarding profile', () => {
  it('returns an empty profile right after registration and completes onboarding', async () => {
    const user = await registerUser(h());

    const before = await get(h(), '/api/v1/users/me', user.token);
    expect(before.statusCode).toBe(200);
    expect(before.json().user.phone).toBeNull();
    expect(before.json().user.country).toBeNull();
    expect(before.json().user.userType).toBeNull();
    expect(before.json().user.organizationName).toBeNull();
    expect(before.json().user.onboardingCompletedAt).toBeNull();
    // Email is verified at registration in this build (no mail transport).
    expect(before.json().user.emailVerifiedAt).toBeTruthy();

    const res = await patch(
      h(),
      '/api/v1/users/me',
      {
        phone: '+1 555 0100',
        country: 'Canada',
        organizationName: 'Acme Studios',
        userType: 'FREELANCER',
        completeOnboarding: true,
      },
      user.token,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().user.userType).toBe('FREELANCER');
    expect(res.json().user.country).toBe('Canada');
    expect(res.json().user.onboardingCompletedAt).toBeTruthy();

    const after = await get(h(), '/api/v1/auth/session', user.token);
    expect(after.json().user.organizationName).toBe('Acme Studios');
    expect(after.json().user.phone).toBe('+1 555 0100');
  });

  it('validates the user type enum', async () => {
    const user = await registerUser(h());
    const res = await patch(h(), '/api/v1/users/me', { userType: 'ROBOT' }, user.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('updates the display name', async () => {
    const user = await registerUser(h());
    const res = await patch(h(), '/api/v1/users/me', { displayName: 'New Name' }, user.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.displayName).toBe('New Name');
  });
});

describe('password reset', () => {
  it('completes the forgot → reset flow and revokes existing sessions', async () => {
    const user = await registerUser(h());

    const forgot = await post(h(), '/api/v1/auth/forgot-password', { email: user.email });
    expect(forgot.statusCode).toBe(200);
    expect(forgot.json().ok).toBe(true);
    const queued = await latestEmailFor(h(), user.email, 'PASSWORD_RESET');
    expect(queued).not.toBeNull();
    const token = queued!.payload.token as string;
    expect(token).toBeTruthy();
    // The raw token is delivered by email, never returned by the API.
    expect(forgot.json().devResetToken).toBeUndefined();

    const reset = await post(h(), '/api/v1/auth/reset-password', {
      token,
      password: 'BrandNewPass123',
    });
    expect(reset.statusCode).toBe(200);

    // Pre-reset session was revoked.
    const oldSession = await get(h(), '/api/v1/auth/session', user.token);
    expect(oldSession.statusCode).toBe(401);

    // Old password no longer works; new one does.
    const oldPw = await post(h(), '/api/v1/auth/login', {
      email: user.email,
      password: 'Password123',
    });
    expect(oldPw.statusCode).toBe(401);
    const newPw = await post(h(), '/api/v1/auth/login', {
      email: user.email,
      password: 'BrandNewPass123',
    });
    expect(newPw.statusCode).toBe(200);
  });

  it('answers uniformly for unknown emails (no account enumeration)', async () => {
    const known = await registerUser(h());
    const knownRes = await post(h(), '/api/v1/auth/forgot-password', { email: known.email });
    const unknownRes = await post(h(), '/api/v1/auth/forgot-password', {
      email: 'nobody-here@example.com',
    });

    expect(knownRes.statusCode).toBe(unknownRes.statusCode);
    expect(knownRes.json().ok).toBe(true);
    expect(unknownRes.json().ok).toBe(true);
    // No token is ever echoed in the response.
    expect(knownRes.json().devResetToken).toBeUndefined();
    expect(unknownRes.json().devResetToken).toBeUndefined();
    // Only a known account produces an outbound message.
    expect(await latestEmailFor(h(), known.email, 'PASSWORD_RESET')).not.toBeNull();
    expect(await latestEmailFor(h(), 'nobody-here@example.com', 'PASSWORD_RESET')).toBeNull();
  });

  it('rejects invalid and replayed reset tokens', async () => {
    const user = await registerUser(h());

    const garbage = await post(h(), '/api/v1/auth/reset-password', {
      token: 'definitely-not-a-real-token',
      password: 'BrandNewPass123',
    });
    expect(garbage.statusCode).toBe(400);
    expect(garbage.json().code).toBe('INVALID_RESET_TOKEN');

    const forgot = await post(h(), '/api/v1/auth/forgot-password', { email: user.email });
    const token = (await latestEmailFor(h(), user.email, 'PASSWORD_RESET'))!.payload
      .token as string;
    const first = await post(h(), '/api/v1/auth/reset-password', {
      token,
      password: 'BrandNewPass123',
    });
    expect(first.statusCode).toBe(200);
    const replay = await post(h(), '/api/v1/auth/reset-password', {
      token,
      password: 'AnotherPass123',
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().code).toBe('INVALID_RESET_TOKEN');
  });

  it('rejects weak new passwords at validation level', async () => {
    const user = await registerUser(h());
    await post(h(), '/api/v1/auth/forgot-password', { email: user.email });
    const token = (await latestEmailFor(h(), user.email, 'PASSWORD_RESET'))!.payload
      .token as string;
    const res = await post(h(), '/api/v1/auth/reset-password', {
      token,
      password: 'short',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });
});

describe('password change', () => {
  it('requires the correct current password and keeps the current session', async () => {
    const user = await registerUser(h());

    const wrong = await post(
      h(),
      '/api/v1/auth/change-password',
      { currentPassword: 'NotThePass123', newPassword: 'BrandNewPass123' },
      user.token,
    );
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe('CURRENT_PASSWORD_INVALID');

    const ok = await post(
      h(),
      '/api/v1/auth/change-password',
      { currentPassword: 'Password123', newPassword: 'BrandNewPass123' },
      user.token,
    );
    expect(ok.statusCode).toBe(200);

    // Current session survives; the old password does not.
    const session = await get(h(), '/api/v1/auth/session', user.token);
    expect(session.statusCode).toBe(200);
    const oldPw = await post(h(), '/api/v1/auth/login', {
      email: user.email,
      password: 'Password123',
    });
    expect(oldPw.statusCode).toBe(401);
  });
});

describe('session management', () => {
  it('lists active sessions, marks the current one, and revokes others', async () => {
    const email = uniqueEmail('sessions');
    const first = await post(h(), '/api/v1/auth/register', {
      email,
      password: 'Password123',
      displayName: 'Sessions User',
    });
    const tokenA = first.json().token as string;
    const second = await post(h(), '/api/v1/auth/login', { email, password: 'Password123' });
    const tokenB = second.json().token as string;

    // Viewed from session A: A is current, B is not.
    const list = await get(h(), '/api/v1/auth/sessions', tokenA);
    expect(list.statusCode).toBe(200);
    const sessions = list.json().sessions as Array<{
      id: string;
      current: boolean;
      userAgent: string | null;
    }>;
    expect(sessions).toHaveLength(2);
    const idA = sessions.find((s) => s.current)!.id;
    const idB = sessions.find((s) => !s.current)!.id;
    expect(idA).not.toBe(idB);

    // Viewed from session B: B is current.
    const listB = await get(h(), '/api/v1/auth/sessions', tokenB);
    const sessionsB = listB.json().sessions as Array<{ id: string; current: boolean }>;
    expect(sessionsB.find((s) => s.current)!.id).toBe(idB);

    // Revoke session A from session B's context.
    const revoke = await del(h(), `/api/v1/auth/sessions/${idA}`, tokenB);
    expect(revoke.statusCode).toBe(204);
    const afterA = await get(h(), '/api/v1/auth/session', tokenA);
    expect(afterA.statusCode).toBe(401); // A was revoked
    const afterB = await get(h(), '/api/v1/auth/session', tokenB);
    expect(afterB.statusCode).toBe(200); // B unaffected

    // Already-revoked session id → 404.
    const again = await del(h(), `/api/v1/auth/sessions/${idA}`, tokenB);
    expect(again.statusCode).toBe(404);

    // Foreign session id → 404 (no cross-user deletion).
    const other = await registerUser(h());
    const notMine = await del(h(), `/api/v1/auth/sessions/${idB}`, other.token);
    expect(notMine.statusCode).toBe(404);
  });

  it('logout-all revokes every session', async () => {
    const email = uniqueEmail('logoutall');
    const first = await post(h(), '/api/v1/auth/register', {
      email,
      password: 'Password123',
      displayName: 'Logout All',
    });
    const tokenA = first.json().token as string;
    await post(h(), '/api/v1/auth/login', { email, password: 'Password123' });

    const out = await post(h(), '/api/v1/auth/logout-all', {}, tokenA);
    expect(out.statusCode).toBe(204);
    const session = await get(h(), '/api/v1/auth/session', tokenA);
    expect(session.statusCode).toBe(401);
    const login = await post(h(), '/api/v1/auth/login', { email, password: 'Password123' });
    expect(login.statusCode).toBe(200); // credentials still valid
  });
});
