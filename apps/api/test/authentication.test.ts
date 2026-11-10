/**
 * Authentication: register, login, sessions, logout, credential hygiene.
 */
import { describe, expect, it } from 'vitest';
import {
  TEST_PASSWORD,
  get,
  post,
  registerUser,
  uniqueEmail,
  useTestApp,
} from './helpers.js';

const h = useTestApp();

describe('authentication', () => {
  it('registers a user with a session token and never exposes credential material', async () => {
    const email = uniqueEmail('alice');
    const res = await post(h(), '/api/v1/auth/register', {
      email,
      password: TEST_PASSWORD,
      displayName: 'Alice',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ email, displayName: 'Alice' });
    expect(body.user).not.toHaveProperty('password');
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(20);
    // The raw response must never contain the password or an argon2 hash.
    expect(res.body).not.toContain(TEST_PASSWORD);
    expect(res.body).not.toContain('$argon2');

    // Only the Argon2id hash is stored server-side.
    const { rows } = await h().db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0]?.password_hash).not.toContain(TEST_PASSWORD);
  });

  it('rejects duplicate registration with 409', async () => {
    const email = uniqueEmail('dup');
    await registerUser(h(), email);
    const res = await post(h(), '/api/v1/auth/register', {
      email: email.toUpperCase(),
      password: TEST_PASSWORD,
      displayName: 'Impostor',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('EMAIL_TAKEN');
  });

  it('rejects a weak password at validation level', async () => {
    const res = await post(h(), '/api/v1/auth/register', {
      email: uniqueEmail('weak'),
      password: 'short',
      displayName: 'Weak',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('rejects a wrong password with 401 and does not leak which field failed', async () => {
    const email = uniqueEmail('bob');
    await registerUser(h(), email);
    const res = await post(h(), '/api/v1/auth/login', {
      email,
      password: 'WrongPassword999',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
    expect(res.json().detail).toBe('Invalid email or password.');
  });

  it('rejects login for an unknown email with the same 401', async () => {
    const res = await post(h(), '/api/v1/auth/login', {
      email: uniqueEmail('ghost'),
      password: TEST_PASSWORD,
    });
    expect(res.statusCode).toBe(401);
  });

  it('authenticates /users/me with the bearer token but rejects without it', async () => {
    const user = await registerUser(h());
    const ok = await get(h(), '/api/v1/users/me', user.token);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.id).toBe(user.userId);

    const anon = await get(h(), '/api/v1/users/me');
    expect(anon.statusCode).toBe(401);

    const bogus = await get(h(), '/api/v1/users/me', 'not-a-real-token');
    expect(bogus.statusCode).toBe(401);
  });

  it('sets an httpOnly session cookie and accepts it for authentication', async () => {
    const email = uniqueEmail('cookie');
    const res = await post(h(), '/api/v1/auth/register', {
      email,
      password: TEST_PASSWORD,
      displayName: 'Cookie',
    });
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
    expect(cookieStr).toContain('ah_session=');
    expect(cookieStr.toLowerCase()).toContain('httponly');

    const cookieValue = cookieStr.split('ah_session=')[1]?.split(';')[0];
    const me = await h().app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { cookie: `ah_session=${cookieValue}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(email);
  });

  it('revokes the session on logout', async () => {
    const user = await registerUser(h());
    const out = await post(h(), '/api/v1/auth/logout', {}, user.token);
    expect(out.statusCode).toBe(204);
    const after = await get(h(), '/api/v1/users/me', user.token);
    expect(after.statusCode).toBe(401);
  });

  it('never stores the raw session token (only its SHA-256 hash)', async () => {
    const user = await registerUser(h());
    const { rows } = await h().db.query<{ token_hash: string }>(
      `SELECT token_hash FROM auth_sessions WHERE user_id = $1`,
      [user.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.token_hash).not.toBe(user.token);
  });
});
