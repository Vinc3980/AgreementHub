/**
 * Avatar storage + access control.
 *
 * Bytes are validated by magic bytes (never by filename or the multipart
 * MIME header) and re-encoded to a 256x256 WebP. Re-encoding strips EXIF,
 * GPS, and every other metadata block. Files live under STORAGE_DIR/avatars/
 * with random write-once keys; keys and paths never leave the server.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { AppError } from '@agreementhub/domain';
import type { Config } from '../config.js';
import { many, one, type Queryable } from '../db.js';
import { resolveStorageKey } from './storage.js';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_EDGE = 256;

/** A single user-facing message for every rejected upload. */
export const INVALID_AVATAR_MESSAGE = 'Use a PNG, JPG or WebP under 2 MB.';

export type AvatarImageType = 'png' | 'jpeg' | 'webp';

export interface AvatarRecord {
  key: string | null;
  updatedAt: Date | null;
}

/** The authenticated avatar route, or null when the user has no picture. */
export function avatarUrl(userId: string, updatedAt: Date | null | undefined): string | null {
  if (!updatedAt) return null;
  return `/api/v1/users/${userId}/avatar?v=${updatedAt.getTime()}`;
}

/** Batch avatar URL lookup for party lists: user id -> authenticated URL. */
export async function avatarUrlsForUsers(
  db: Queryable,
  userIds: Array<string | null>,
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const rows = await many<{
    id: string;
    avatar_key: string | null;
    avatar_updated_at: Date | null;
  }>(
    db,
    `SELECT id, avatar_key, avatar_updated_at
       FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [ids],
  );
  const out = new Map<string, string>();
  for (const row of rows) {
    const url = row.avatar_key ? avatarUrl(row.id, row.avatar_updated_at) : null;
    if (url) out.set(row.id, url);
  }
  return out;
}

/** Detect PNG / JPEG / WebP from the first bytes only. */
export function sniffAvatarType(bytes: Buffer): AvatarImageType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/** Re-encode to 256x256 WebP, which also drops all metadata (EXIF/GPS). */
export async function normalizeAvatar(bytes: Buffer): Promise<Buffer> {
  if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES || !sniffAvatarType(bytes)) {
    throw AppError.badRequest('INVALID_AVATAR', INVALID_AVATAR_MESSAGE);
  }
  try {
    return await sharp(bytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize(AVATAR_EDGE, AVATAR_EDGE, { fit: 'cover', position: 'centre' })
      .webp({ quality: 84 })
      .toBuffer();
  } catch {
    // Truncated or malformed image data: same answer as an unsupported type.
    throw AppError.badRequest('INVALID_AVATAR', INVALID_AVATAR_MESSAGE);
  }
}

export async function getAvatarRecord(
  db: Queryable,
  userId: string,
): Promise<AvatarRecord | undefined> {
  const row = await one<{ avatar_key: string | null; avatar_updated_at: Date | null }>(
    db,
    `SELECT avatar_key, avatar_updated_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!row) return undefined;
  return { key: row.avatar_key, updatedAt: row.avatar_updated_at };
}

/** Store a new avatar and remove the previous file after the row commits. */
export async function setAvatar(
  db: Queryable,
  config: Config,
  userId: string,
  rawBytes: Buffer,
): Promise<AvatarRecord> {
  const bytes = await normalizeAvatar(rawBytes);
  const previous = await getAvatarRecord(db, userId);
  if (!previous) throw AppError.notFound('User not found.');

  const key = `avatars/${randomUUID()}.webp`;
  const path = resolveStorageKey(config, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });

  const row = await one<{ avatar_key: string; avatar_updated_at: Date }>(
    db,
    `UPDATE users
        SET avatar_key = $2, avatar_updated_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING avatar_key, avatar_updated_at`,
    [userId, key],
  );
  if (!row) {
    await unlink(path).catch(() => undefined);
    throw AppError.notFound('User not found.');
  }
  if (previous.key) await unlink(resolveStorageKey(config, previous.key)).catch(() => undefined);
  return { key: row.avatar_key, updatedAt: row.avatar_updated_at };
}

/** Clear the row first, then delete the bytes. Returns whether a file existed. */
export async function clearAvatar(
  db: Queryable,
  config: Config,
  userId: string,
): Promise<boolean> {
  const row = await one<{ old_avatar_key: string | null }>(
    db,
    `WITH old AS (
       SELECT avatar_key
         FROM users
        WHERE id = $1 AND deleted_at IS NULL
     )
     UPDATE users u
        SET avatar_key = NULL, avatar_updated_at = NULL, updated_at = now()
       FROM old
      WHERE u.id = $1
      RETURNING old.avatar_key AS old_avatar_key`,
    [userId],
  );
  if (!row) throw AppError.notFound('User not found.');
  if (!row.old_avatar_key) return false;
  await unlink(resolveStorageKey(config, row.old_avatar_key)).catch(() => undefined);
  return true;
}

/**
 * Self, or anyone who shares at least one agreement with the target.
 * Every denial is a plain 404 so the route is not an existence oracle.
 */
async function canViewAvatar(
  db: Queryable,
  viewerId: string,
  targetId: string,
): Promise<boolean> {
  if (viewerId === targetId) return true;
  const shared = await one<{ ok: boolean }>(
    db,
    `SELECT EXISTS (
       SELECT 1
         FROM agreement_parties mine
         JOIN agreement_parties theirs ON theirs.agreement_id = mine.agreement_id
        WHERE mine.user_id = $1 AND theirs.user_id = $2
     ) AS ok`,
    [viewerId, targetId],
  );
  return shared?.ok === true;
}

export async function readAvatarForViewer(
  db: Queryable,
  config: Config,
  viewerId: string,
  targetId: string,
): Promise<{ bytes: Buffer; etag: string }> {
  if (!(await canViewAvatar(db, viewerId, targetId))) {
    throw AppError.notFound('Avatar not found.');
  }
  const record = await getAvatarRecord(db, targetId);
  if (!record?.key) throw AppError.notFound('Avatar not found.');

  let bytes: Buffer;
  try {
    bytes = await readFile(resolveStorageKey(config, record.key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw AppError.notFound('Avatar not found.');
    }
    throw err;
  }
  const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
  return { bytes, etag };
}
