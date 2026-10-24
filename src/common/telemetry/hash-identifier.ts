import { createHmac } from 'node:crypto';

/**
 * Stable pseudonym for a user id in logs (architecture plan §4.6). The raw id is
 * never logged, and the salt keeps two deployments from correlating each other's
 * users. This is not authentication: it only avoids storing direct identifiers.
 */
export function hashIdentifier(
  value: string | undefined,
  salt: string,
): string | undefined {
  if (!value) return undefined;
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 12);
}
