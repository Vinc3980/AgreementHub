/**
 * Password hashing, Argon2id via @node-rs/argon2 (prebuilt native binding).
 * Passwords are never stored or logged in plain text; only the PHC-format
 * hash string is persisted (contains algorithm params + salt + digest).
 * The library defaults to Argon2id v19 (m=19456, t=2, p=1).
 */
import { hash, verify } from '@node-rs/argon2';

const ARGON2_OPTS = {
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTS);
}

/** Constant-time verification; returns false on malformed hashes instead of throwing. */
export async function verifyPassword(phcHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(phcHash, plain, ARGON2_OPTS);
  } catch {
    return false;
  }
}
