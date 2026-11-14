import { hash, verify } from '@node-rs/argon2';

/**
 * Admin password hashing (docs/admin/admin-auth.md §6).
 *
 * Argon2id with 64 MiB / 3 passes / 1 lane. The encoded hash carries its own
 * parameters, so raising the cost later does not invalidate existing hashes;
 * rehash on the next successful sign-in instead.
 *
 * `@node-rs/argon2` exports `Algorithm` as an ambient const enum, which
 * `isolatedModules` forbids reading. 2 is `Algorithm.Argon2id` in that enum.
 */
const ARGON2ID = 2;

const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 256;

export type AdminPasswordPolicyError = 'too_short' | 'too_long';

export function validateAdminPassword(
  password: string,
): AdminPasswordPolicyError | null {
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > ADMIN_PASSWORD_MAX_LENGTH) return 'too_long';
  return null;
}

export class AdminPasswordPolicyViolation extends Error {
  constructor(readonly reason: AdminPasswordPolicyError) {
    super(`Admin password rejected: ${reason}`);
    this.name = 'AdminPasswordPolicyViolation';
  }
}

export async function hashAdminPassword(password: string): Promise<string> {
  const policyError = validateAdminPassword(password);
  if (policyError) throw new AdminPasswordPolicyViolation(policyError);
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Returns false for every failure, including a malformed stored hash. Callers
 * must not distinguish "wrong password" from "no such account"; the service
 * verifies against {@link DUMMY_PASSWORD_HASH} when the email is unknown so
 * both paths spend the same work.
 */
export async function verifyAdminPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  if (!passwordHash || !password) return false;
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * A real Argon2id hash of a value that is not a credential. Used only to keep
 * the unknown-email path indistinguishable from a wrong-password path.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$fG5Zz807ImBdpf/X/WF58Q$FYLRKNzFAdgH0c7p/xlyGYUHzboEIZ5Hvgy8RCzTUx8';
