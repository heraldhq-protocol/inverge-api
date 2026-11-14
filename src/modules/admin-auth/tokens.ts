import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Opaque admin tokens and identifier hashes (docs/admin/admin-auth.md §7).
 *
 * Tokens carry no claims: the API looks up their SHA-256 hash and resolves the
 * admin row on every request. That makes revocation immediate and avoids a
 * second JWT audience sharing the product's signing key.
 */
export const ADMIN_SESSION_PREFIX = 'inv_adm_';
export const ADMIN_CHALLENGE_PREFIX = 'inv_chl_';
export const ADMIN_TOKEN_BYTES = 32;

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_GROUP_LENGTH = 5;

export function createOpaqueToken(prefix: string): string {
  return `${prefix}${randomBytes(ADMIN_TOKEN_BYTES).toString('base64url')}`;
}

export function createAdminSessionToken(): string {
  return createOpaqueToken(ADMIN_SESSION_PREFIX);
}

export function createAdminChallengeToken(): string {
  return createOpaqueToken(ADMIN_CHALLENGE_PREFIX);
}

export function hashAdminToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * HMAC rather than a bare hash: an IP or user-agent has a small input space and
 * a database dump should not be dictionary-matchable. The pepper is
 * `ADMIN_HASH_PEPPER`, required in production when admin auth is enforced.
 */
export function hashAdminIdentifier(
  value: string | null | undefined,
  pepper: string,
): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return createHmac('sha256', pepper).update(normalized, 'utf8').digest('hex');
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Ten characters from an unambiguous alphabet, shown as `XXXXX-XXXXX`.
 * Callers hash the normalized form, so dashes and casing never affect matching.
 */
export function createRecoveryCode(): string {
  const raw = Array.from(
    randomBytes(10),
    (byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length],
  ).join('');
  return `${raw.slice(0, RECOVERY_GROUP_LENGTH)}-${raw.slice(RECOVERY_GROUP_LENGTH)}`;
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256')
    .update(normalizeRecoveryCode(code), 'utf8')
    .digest('hex');
}
