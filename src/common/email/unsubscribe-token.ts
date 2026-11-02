import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'unsubscribe:v1';

function signature(secret: string, subscriptionId: string): string {
  return createHmac('sha256', secret)
    .update(`${PREFIX}:${subscriptionId}`)
    .digest('base64url');
}

/**
 * Stateless unsubscribe token: `<subscriptionId>.<HMAC>`.
 *
 * Nothing is stored, so a database leak alone cannot mint a token, and the link
 * keeps working for the life of the subscription. Rotating the secret revokes
 * every outstanding link.
 */
export function createUnsubscribeToken(
  secret: string,
  subscriptionId: string,
): string {
  return `${subscriptionId}.${signature(secret, subscriptionId)}`;
}

/** Returns the subscription id, or null for a malformed or forged token. */
export function verifyUnsubscribeToken(
  secret: string,
  token: string,
): string | null {
  const separator = token.lastIndexOf('.');
  if (separator <= 0 || separator === token.length - 1) return null;
  const subscriptionId = token.slice(0, separator);
  const given = token.slice(separator + 1);
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(subscriptionId)) return null;

  const expected = Buffer.from(signature(secret, subscriptionId), 'utf8');
  const actual = Buffer.from(given, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual)
    ? subscriptionId
    : null;
}
