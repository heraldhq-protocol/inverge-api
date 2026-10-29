/**
 * Email normalisation shared by every write and lookup.
 *
 * Stored addresses are lower-case. The database also enforces this with a CHECK
 * constraint, so a write that bypasses this helper fails instead of creating a
 * second, case-variant account.
 */
export const MAX_EMAIL_LENGTH = 254;

const LOCAL_PART = /^[^\s@]+$/;
const DOMAIN_PART = /^[^\s@.]+(\.[^\s@.]+)+$/;

/** Lower-case, trimmed address, or null when the input is not a usable email. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LENGTH) {
    return null;
  }
  if (normalized.includes('..') || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return null;
  }

  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return null;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!LOCAL_PART.test(local) || !DOMAIN_PART.test(domain)) return null;

  return normalized;
}

/** True when the value normalises to a plausible address. */
export function isEmailAddress(value: unknown): value is string {
  return normalizeEmail(value) !== null;
}
