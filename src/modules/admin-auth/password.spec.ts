import {
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MIN_LENGTH,
  AdminPasswordPolicyViolation,
  DUMMY_PASSWORD_HASH,
  hashAdminPassword,
  validateAdminPassword,
  verifyAdminPassword,
} from './password';

describe('admin password hashing', () => {
  describe('#given a password that meets the policy', () => {
    it('#then it round-trips through Argon2id', async () => {
      const password = 'correct horse battery staple';
      const passwordHash = await hashAdminPassword(password);

      expect(passwordHash.startsWith('$argon2id$')).toBe(true);
      await expect(verifyAdminPassword(passwordHash, password)).resolves.toBe(
        true,
      );
    });

    it('#then a different password is rejected', async () => {
      const passwordHash = await hashAdminPassword('a-long-admin-password');
      await expect(
        verifyAdminPassword(passwordHash, 'a-long-admin-passwore'),
      ).resolves.toBe(false);
    });
  });

  describe('#given a password outside the policy', () => {
    it('#then a short password is rejected', () => {
      expect(validateAdminPassword('a'.repeat(11))).toBe('too_short');
      return expect(hashAdminPassword('a'.repeat(11))).rejects.toBeInstanceOf(
        AdminPasswordPolicyViolation,
      );
    });

    it('#then an over-long password is rejected', () => {
      expect(
        validateAdminPassword('a'.repeat(ADMIN_PASSWORD_MAX_LENGTH + 1)),
      ).toBe('too_long');
    });

    it('#then the boundary lengths are accepted', () => {
      expect(
        validateAdminPassword('a'.repeat(ADMIN_PASSWORD_MIN_LENGTH)),
      ).toBeNull();
      expect(
        validateAdminPassword('a'.repeat(ADMIN_PASSWORD_MAX_LENGTH)),
      ).toBeNull();
    });
  });

  describe('#given a stored hash that is not valid Argon2id', () => {
    it('#then verification fails rather than throwing', async () => {
      await expect(
        verifyAdminPassword('not-a-hash', 'a-long-admin-password'),
      ).resolves.toBe(false);
      await expect(
        verifyAdminPassword('', 'a-long-admin-password'),
      ).resolves.toBe(false);
    });
  });

  describe('#given the dummy hash used for unknown emails', () => {
    it('#then it is a real Argon2id hash and accepts no useful password', async () => {
      expect(DUMMY_PASSWORD_HASH.startsWith('$argon2id$')).toBe(true);
      await expect(
        verifyAdminPassword(DUMMY_PASSWORD_HASH, 'not-the-dummy-value'),
      ).resolves.toBe(false);
    });
  });
});
