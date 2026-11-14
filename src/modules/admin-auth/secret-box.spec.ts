import { randomBytes } from 'node:crypto';

import {
  AdminSecretBoxError,
  decryptAdminSecret,
  encryptAdminSecret,
  parseAdminEncryptionKey,
} from './secret-box';

const key = randomBytes(32);

describe('admin secret box', () => {
  describe('#given a TOTP secret and a key', () => {
    it('#then it round-trips', () => {
      const payload = encryptAdminSecret('GEZDGNBVGY3TQOJQ', key);
      expect(payload.startsWith('v1.')).toBe(true);
      expect(payload).not.toContain('GEZDGNBVGY3TQOJQ');
      expect(decryptAdminSecret(payload, key)).toBe('GEZDGNBVGY3TQOJQ');
    });

    it('#then a fresh IV makes every payload different', () => {
      const first = encryptAdminSecret('same-secret', key);
      const second = encryptAdminSecret('same-secret', key);
      expect(first).not.toBe(second);
      expect(decryptAdminSecret(first, key)).toBe('same-secret');
      expect(decryptAdminSecret(second, key)).toBe('same-secret');
    });
  });

  describe('#given the wrong key', () => {
    it('#then decryption fails instead of returning garbage', () => {
      const payload = encryptAdminSecret('a-secret', key);
      expect(() => decryptAdminSecret(payload, randomBytes(32))).toThrow(
        AdminSecretBoxError,
      );
    });
  });

  describe('#given a tampered payload', () => {
    it('#then authentication fails', () => {
      const payload = encryptAdminSecret('a-secret', key);
      const parts = payload.split('.');
      const ciphertext = Buffer.from(parts[3], 'base64url');
      ciphertext[0] ^= 0xff;
      const tampered = [
        parts[0],
        parts[1],
        parts[2],
        ciphertext.toString('base64url'),
      ].join('.');

      expect(() => decryptAdminSecret(tampered, key)).toThrow(
        AdminSecretBoxError,
      );
    });

    it('#then a malformed payload is rejected', () => {
      expect(() => decryptAdminSecret('not-a-payload', key)).toThrow(
        AdminSecretBoxError,
      );
      expect(() => decryptAdminSecret('v2.a.b.c', key)).toThrow(
        AdminSecretBoxError,
      );
    });
  });

  describe('#given a key of the wrong length', () => {
    it('#then encryption and decryption reject it', () => {
      expect(() => encryptAdminSecret('a-secret', randomBytes(16))).toThrow(
        AdminSecretBoxError,
      );
      expect(() => decryptAdminSecret('v1.a.b.c', randomBytes(16))).toThrow(
        AdminSecretBoxError,
      );
    });
  });

  describe('#given the base64 environment value', () => {
    it('#then exactly 32 decoded bytes are accepted', () => {
      expect(
        parseAdminEncryptionKey(randomBytes(32).toString('base64')),
      ).toHaveLength(32);
      expect(() =>
        parseAdminEncryptionKey(randomBytes(16).toString('base64')),
      ).toThrow(AdminSecretBoxError);
    });
  });
});
