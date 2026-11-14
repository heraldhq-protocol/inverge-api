import {
  ADMIN_CHALLENGE_PREFIX,
  ADMIN_SESSION_PREFIX,
  createAdminChallengeToken,
  createAdminSessionToken,
  createOpaqueToken,
  createRecoveryCode,
  hashAdminIdentifier,
  hashAdminToken,
  hashRecoveryCode,
  normalizeRecoveryCode,
  safeEqual,
} from './tokens';

describe('admin tokens', () => {
  describe('#given a session token', () => {
    it('#then it carries the admin prefix and is unique', () => {
      const first = createAdminSessionToken();
      const second = createAdminSessionToken();

      expect(first.startsWith(ADMIN_SESSION_PREFIX)).toBe(true);
      expect(second.startsWith(ADMIN_SESSION_PREFIX)).toBe(true);
      expect(first).not.toBe(second);
    });

    it('#then only its hash is stable and comparable', () => {
      const token = createAdminSessionToken();
      expect(hashAdminToken(token)).toBe(hashAdminToken(token));
      expect(hashAdminToken(token)).toMatch(/^[a-f0-9]{64}$/);
      expect(hashAdminToken(token)).not.toContain(token);
    });

    it('#then the challenge prefix is distinct', () => {
      const challenge = createAdminChallengeToken();
      expect(challenge.startsWith(ADMIN_CHALLENGE_PREFIX)).toBe(true);
      expect(challenge.startsWith(ADMIN_SESSION_PREFIX)).toBe(false);
    });
  });

  describe('#given an opaque token with no prefix argument', () => {
    it('#then an empty prefix is still allowed only with a caller-supplied value', () => {
      expect(createOpaqueToken('')).toHaveLength(43);
    });
  });

  describe('#given identifier hashing with a pepper', () => {
    it('#then the same value and pepper produce the same hash', () => {
      const pepper = 'a'.repeat(32);
      expect(hashAdminIdentifier('203.0.113.4', pepper)).toBe(
        hashAdminIdentifier('203.0.113.4', pepper),
      );
    });

    it('#then a different pepper produces a different hash', () => {
      expect(hashAdminIdentifier('203.0.113.4', 'a'.repeat(32))).not.toBe(
        hashAdminIdentifier('203.0.113.4', 'b'.repeat(32)),
      );
    });

    it('#then empty identifiers return null', () => {
      expect(hashAdminIdentifier('', 'a'.repeat(32))).toBeNull();
      expect(hashAdminIdentifier('   ', 'a'.repeat(32))).toBeNull();
      expect(hashAdminIdentifier(undefined, 'a'.repeat(32))).toBeNull();
    });
  });

  describe('#given a recovery code', () => {
    it('#then it is ten unambiguous characters in two groups', () => {
      const code = createRecoveryCode();
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      expect(code).toHaveLength(11);
    });

    it('#then normalization ignores case, dashes and spaces', () => {
      expect(normalizeRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
      expect(normalizeRecoveryCode(' abcde fghjk ')).toBe('ABCDEFGHJK');
    });

    it('#then hashing the normalized form is stable', () => {
      expect(hashRecoveryCode('abcde-fghjk')).toBe(
        hashRecoveryCode('ABCDE FGHJK'),
      );
    });
  });

  describe('#given safeEqual', () => {
    it('#then equal strings pass and different lengths fail', () => {
      expect(safeEqual('abc', 'abc')).toBe(true);
      expect(safeEqual('abc', 'abd')).toBe(false);
      expect(safeEqual('abc', 'abcd')).toBe(false);
    });
  });
});
