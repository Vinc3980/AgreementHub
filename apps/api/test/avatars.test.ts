/**
 * Profile pictures (avatars): upload, validation, metadata stripping, access
 * control, and deletion. The authenticated route never leaks storage keys and
 * returns 404 (not 403) for invisible users so it cannot act as an oracle.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveStorageKey } from '../src/services/storage.js';
import {
  authHeaders,
  registerUser,
  setupAwaitingSignatures,
  testConfig,
  uniqueEmail,
  useTestApp,
} from './helpers.js';

const storageDir = await mkdtemp(join(tmpdir(), 'ah-avatars-'));
const h = useTestApp({ STORAGE_DIR: storageDir });

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

async function pngBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 320, height: 200, channels: 3, background: { r: 30, g: 50, b: 90 } },
  })
    .png()
    .toBuffer();
}

/** A valid PNG carrying EXIF so we can prove the pipeline strips metadata. */
async function pngWithExifBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 220, height: 180, channels: 3, background: { r: 90, g: 60, b: 40 } },
  })
    .withExif({
      IFD0: {
        Copyright: 'sensitive-location-marker',
        ImageDescription: 'should-not-survive',
      },
    })
    .png()
    .toBuffer();
}

function multipart(
  bytes: Buffer,
  filename: string,
  contentType: string,
): { payload: Buffer; contentType: string } {
  const boundary = `----ah${Date.now()}${Math.random().toString(16).slice(2)}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), bytes, Buffer.from(tail)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function uploadAvatar(
  token: string,
  bytes: Buffer,
  filename = 'photo.png',
  contentType = 'image/png',
) {
  const body = multipart(bytes, filename, contentType);
  return h().app.inject({
    method: 'POST',
    url: '/api/v1/users/me/avatar',
    headers: { ...authHeaders(token), 'content-type': body.contentType },
    payload: body.payload,
  });
}

describe('profile pictures', () => {
  it('rejects a wrong file type even when renamed .png', async () => {
    const user = await registerUser(h());
    const notAnImage = Buffer.from('this is plain text, not an image');
    const res = await uploadAvatar(user.token, notAnImage, 'avatar.png', 'image/png');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_AVATAR');
    expect(res.json().detail).toBe('Use a PNG, JPG or WebP under 2 MB.');
  });

  it('rejects an oversized upload', async () => {
    const user = await registerUser(h());
    // Starts with the PNG signature so only the size gate matters.
    const oversize = Buffer.alloc(2 * 1024 * 1024 + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]).copy(oversize);
    const res = await uploadAvatar(user.token, oversize, 'big.png', 'image/png');
    expect([400, 413]).toContain(res.statusCode);
    expect(res.json().detail).toBe('Use a PNG, JPG or WebP under 2 MB.');
  });

  it('re-encodes to 256x256 WebP and strips EXIF metadata', async () => {
    const user = await registerUser(h());
    const res = await uploadAvatar(user.token, await pngWithExifBuffer(), 'photo.png', 'image/png');
    expect(res.statusCode).toBe(200);
    expect(res.json().user.avatarUrl).toContain(`/api/v1/users/${user.userId}/avatar?v=`);

    const fetched = await h().app.inject({
      method: 'GET',
      url: `/api/v1/users/${user.userId}/avatar`,
      headers: authHeaders(user.token),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['content-type']).toContain('image/webp');
    expect(fetched.headers['cache-control']).toBe('private, max-age=3600');
    expect(fetched.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);

    const meta = await sharp(Buffer.from(fetched.rawPayload)).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
    expect(meta.exif).toBeUndefined();
    const raw = Buffer.from(fetched.rawPayload).toString('latin1');
    expect(raw).not.toContain('sensitive-location-marker');
  });

  it('allows self and co-parties, returns 404 to strangers (no existence oracle)', async () => {
    const setup = await setupAwaitingSignatures(h());
    const stranger = await registerUser(h(), uniqueEmail('stranger'));

    // Owner uploads a picture.
    const up = await uploadAvatar(setup.owner.token, await pngBuffer());
    expect(up.statusCode).toBe(200);

    const self = await h().app.inject({
      method: 'GET',
      url: `/api/v1/users/${setup.owner.userId}/avatar`,
      headers: authHeaders(setup.owner.token),
    });
    expect(self.statusCode).toBe(200);

    const coParty = await h().app.inject({
      method: 'GET',
      url: `/api/v1/users/${setup.owner.userId}/avatar`,
      headers: authHeaders(setup.counterparty.token),
    });
    expect(coParty.statusCode).toBe(200);

    const denied = await h().app.inject({
      method: 'GET',
      url: `/api/v1/users/${setup.owner.userId}/avatar`,
      headers: authHeaders(stranger.token),
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().code).toBe('NOT_FOUND');
  });

  it('deletes the avatar row and removes the stored file', async () => {
    const user = await registerUser(h());
    const up = await uploadAvatar(user.token, await pngBuffer());
    expect(up.statusCode).toBe(200);

    const { rows } = await h().db.query<{ avatar_key: string }>(
      `SELECT avatar_key FROM users WHERE id = $1`,
      [user.userId],
    );
    expect(rows[0]?.avatar_key).toMatch(/^avatars\/.+\.webp$/);
    const path = resolveStorageKey(testConfig({ STORAGE_DIR: storageDir }), rows[0]!.avatar_key);
    await expect(stat(path)).resolves.toBeTruthy();

    const del = await h().app.inject({
      method: 'DELETE',
      url: '/api/v1/users/me/avatar',
      headers: authHeaders(user.token),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().user.avatarUrl).toBeNull();

    const gone = await h().app.inject({
      method: 'GET',
      url: `/api/v1/users/${user.userId}/avatar`,
      headers: authHeaders(user.token),
    });
    expect(gone.statusCode).toBe(404);

    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
