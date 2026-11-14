import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * At-rest encryption for TOTP secrets (docs/admin/admin-auth.md §6).
 *
 * AES-256-GCM with a 12-byte IV and a version prefix, so a future key or
 * algorithm change can be detected rather than silently misdecrypted. The key
 * is `ADMIN_TOTP_ENCRYPTION_KEY`, base64, exactly 32 bytes.
 */
const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class AdminSecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminSecretBoxError';
  }
}

export function parseAdminEncryptionKey(encoded: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(encoded.trim(), 'base64');
  } catch {
    throw new AdminSecretBoxError('Admin encryption key is not valid base64');
  }

  if (key.length !== KEY_BYTES) {
    throw new AdminSecretBoxError(
      `Admin encryption key must decode to ${KEY_BYTES} bytes`,
    );
  }
  return key;
}

export function encryptAdminSecret(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new AdminSecretBoxError(
      `Admin encryption key must be ${KEY_BYTES} bytes`,
    );
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptAdminSecret(payload: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new AdminSecretBoxError(
      `Admin encryption key must be ${KEY_BYTES} bytes`,
    );
  }

  const [version, ivPart, tagPart, ciphertextPart, ...rest] =
    payload.split('.');
  if (
    version !== VERSION ||
    !ivPart ||
    !tagPart ||
    ciphertextPart === undefined ||
    rest.length > 0
  ) {
    throw new AdminSecretBoxError('Admin secret payload is malformed');
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivPart, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new AdminSecretBoxError('Admin secret could not be decrypted');
  }
}
