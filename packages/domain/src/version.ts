import { sha256Of } from './hash.js';

/** Version lifecycle statuses (SPEC §8, §11). */
export const VERSION_STATUSES = [
  'DRAFT',
  'SUPERSEDED',
  'PENDING_APPROVAL',
  'APPROVED',
  'FINAL',
  'REJECTED',
] as const;

export type VersionStatus = (typeof VERSION_STATUSES)[number];

/** Statuses whose content may still be edited in place (working draft). */
export const MUTABLE_VERSION_STATUSES: readonly VersionStatus[] = ['DRAFT'];

export function isVersionMutable(status: VersionStatus): boolean {
  return MUTABLE_VERSION_STATUSES.includes(status);
}

/**
 * The immutable document payload captured by a version snapshot (SPEC §11.1).
 * The document hash covers exactly this shape, nothing else, so the hash is
 * reproducible from the snapshot alone.
 */
export interface VersionContent {
  agreementPublicId: string;
  title: string;
  templateCode: string;
  sections: Array<{
    code: string;
    title: string;
    body: string;
    included: boolean;
  }>;
  fields: Array<{
    code: string;
    value: unknown;
    provenance: 'USER_PROVIDED' | 'AI_SUGGESTED_CONFIRMED' | 'COMPUTED';
  }>;
  parties: Array<{
    email: string;
    displayName: string;
    role: string;
    signingOrder: number;
  }>;
}

/**
 * Compute the document hash for a version snapshot (SPEC §8/§11).
 * SHA-256 over canonical JSON of the full content, sorted keys, normalised
 * whitespace, so identical content always yields the same hash.
 */
export function computeDocumentHash(content: VersionContent): string {
  return sha256Of(content as unknown as Parameters<typeof sha256Of>[0]);
}
