import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP with RFC 4648 base32 secrets (docs/admin/admin-auth.md §6).
 *
 * SHA-1, six digits and a 30-second step are the interoperable defaults every
 * authenticator app supports. A ±1-step window absorbs clock drift; replay is
 * rejected by comparing the accepted step with the admin's stored last step.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export class TotpSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpSecretError';
  }
}

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function decodeBase32(secret: string): Buffer {
  const normalized = secret.trim().toUpperCase().replace(/=+$/, '');
  if (!normalized) throw new TotpSecretError('TOTP secret is empty');

  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new TotpSecretError('TOTP secret is not valid base32');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  if (output.length === 0) throw new TotpSecretError('TOTP secret is empty');
  return Buffer.from(output);
}

/** A 160-bit secret, the length recommended by RFC 4226 §4. */
export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function totpStep(
  atMs: number = Date.now(),
  stepSeconds: number = TOTP_STEP_SECONDS,
): bigint {
  return BigInt(Math.floor(atMs / 1000 / stepSeconds));
}

export function totpCode(
  secret: string,
  atMs: number = Date.now(),
  stepSeconds: number = TOTP_STEP_SECONDS,
  digits: number = TOTP_DIGITS,
): string {
  const counter = totpStep(atMs, stepSeconds);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);

  const digest = createHmac('sha1', decodeBase32(secret))
    .update(buffer)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export type TotpVerification =
  | { ok: true; step: bigint }
  | { ok: false; reason: 'format' | 'mismatch' | 'replay' };

export function verifyTotpCode({
  secret,
  code,
  atMs = Date.now(),
  stepSeconds = TOTP_STEP_SECONDS,
  digits = TOTP_DIGITS,
  window = TOTP_WINDOW,
  lastStep = null,
}: {
  secret: string;
  code: string;
  atMs?: number;
  stepSeconds?: number;
  digits?: number;
  window?: number;
  lastStep?: bigint | null;
}): TotpVerification {
  const normalized = code.trim();
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) {
    return { ok: false, reason: 'format' };
  }

  const current = totpStep(atMs, stepSeconds);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidateStep = current + BigInt(offset);
    if (candidateStep < 0n) continue;

    const candidate = totpCode(
      secret,
      Number(candidateStep) * stepSeconds * 1000,
      stepSeconds,
      digits,
    );

    const provided = Buffer.from(normalized, 'ascii');
    const expected = Buffer.from(candidate, 'ascii');
    if (
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    ) {
      if (lastStep !== null && candidateStep <= lastStep) {
        return { ok: false, reason: 'replay' };
      }
      return { ok: true, step: candidateStep };
    }
  }

  return { ok: false, reason: 'mismatch' };
}

export function buildTotpUri({
  secret,
  accountName,
  issuer = 'Inverge Admin',
}: {
  secret: string;
  accountName: string;
  issuer?: string;
}): string {
  const label = `${issuer}:${accountName}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
