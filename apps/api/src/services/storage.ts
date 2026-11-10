/**
 * Server-side document storage for the document-generation pipeline
 * (HTML → PDF → hash → storage → verification).
 *
 * Files live under STORAGE_DIR and are only reachable through the
 * authenticated document routes. Neither the storage path nor a storage URL
 * is ever exposed through the API, API clients receive bytes, not locations.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Config } from '../config.js';

export interface StoredDocument {
  key: string;
  sha256: string;
  byteSize: number;
}

/** Absolute root of the server-side storage tree. Never sent to clients. */
export function storageRoot(config: Config): string {
  return resolve(config.STORAGE_DIR);
}

/** Storage key for a version's PDF: `documents/{publicId}/v{n}.pdf`. */
export function documentPdfKey(publicId: string, versionNumber: number): string {
  return join('documents', publicId, `v${versionNumber}.pdf`);
}

/** Resolve a key to an absolute path, contained within the storage root. */
export function resolveStorageKey(config: Config, key: string): string {
  const root = storageRoot(config);
  const path = resolve(root, key);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`storage key escapes storage root: ${key}`);
  }
  return path;
}

/**
 * Write a document exactly once (O_EXCL). If the key already exists the
 * existing bytes are kept and returned, finalized documents are never
 * overwritten by later generations.
 */
export async function putDocumentPdf(
  config: Config,
  key: string,
  bytes: Buffer,
): Promise<StoredDocument & { created: boolean }> {
  const path = resolveStorageKey(config, key);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
    // Someone else stored this document first, keep theirs.
    const existing = await readDocumentPdf(config, key);
    if (!existing) throw err;
    return { key, sha256: existing.sha256, byteSize: existing.bytes.length, created: false };
  }
  return {
    key,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.length,
    created: true,
  };
}

/** Read a stored document's bytes plus the hash of what is actually on disk. */
export async function readDocumentPdf(
  config: Config,
  key: string,
): Promise<{ key: string; bytes: Buffer; sha256: string } | null> {
  try {
    const bytes = await readFile(resolveStorageKey(config, key));
    return { key, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

