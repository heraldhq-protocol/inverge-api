import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

const CODE_LENGTH = 6;
const CODE_SPACE = 10 ** CODE_LENGTH;

/** Uniform six-digit code. `randomInt` avoids the modulo bias of `random % 1e6`. */
export function generateVerificationCode(): string {
  return randomInt(0, CODE_SPACE).toString().padStart(CODE_LENGTH, '0');
}

/** Accepts whitespace around digits, but nothing else. */
export function parseVerificationCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  return /^\d{6}$/.test(code) ? code : null;
}

/**
 * Keyed hash of `challengeId:code`. A database leak alone cannot brute-force the
 * six-digit space without the server-side pepper, and binding the challenge id
 * prevents a hash from being replayed against a different challenge.
 */
export function hashVerificationCode(
  secret: string,
  challengeId: string,
  code: string,
): string {
  return createHmac('sha256', secret)
    .update(`${challengeId}:${code}`)
    .digest('hex');
}

/** Constant-time comparison. The expected value is a hex digest. */
export function verificationCodeMatches(
  expectedHash: string,
  secret: string,
  challengeId: string,
  code: string,
): boolean {
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, 'hex');
  } catch {
    return false;
  }
  const actual = Buffer.from(
    hashVerificationCode(secret, challengeId, code),
    'hex',
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
