import {
  buildTotpUri,
  decodeBase32,
  encodeBase32,
  generateTotpSecret,
  totpCode,
  totpStep,
  verifyTotpCode,
} from './totp';

const RFC_SECRET = encodeBase32(Buffer.from('12345678901234567890', 'ascii'));

describe('TOTP', () => {
  describe('#given the RFC 6238 SHA-1 vectors', () => {
    it.each([
      [59, '287082'],
      [1_111_111_109, '081804'],
      [1_111_111_111, '050471'],
      [1_234_567_890, '005924'],
      [2_000_000_000, '279037'],
      [20_000_000_000, '353130'],
    ])('#then the six-digit code at %i s is %s', (seconds, expected) => {
      expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(expected);
    });

    it('#then the secret encodes canonically', () => {
      expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    });
  });

  describe('#given a generated secret', () => {
    it('#then it is 160 bits of base32 with no padding', () => {
      const secret = generateTotpSecret();
      expect(secret).toHaveLength(32);
      expect(secret).toMatch(/^[A-Z2-7]+$/);
      expect(decodeBase32(secret)).toHaveLength(20);
    });
  });

  describe('#given a code inside the drift window', () => {
    const at = 1_111_111_109_000;

    it('#then the current step verifies', () => {
      expect(
        verifyTotpCode({ secret: RFC_SECRET, code: '081804', atMs: at }),
      ).toEqual({
        ok: true,
        step: totpStep(at),
      });
    });

    it('#then the previous step verifies', () => {
      const previous = totpCode(RFC_SECRET, at - 30_000);
      const result = verifyTotpCode({
        secret: RFC_SECRET,
        code: previous,
        atMs: at,
      });
      expect(result.ok).toBe(true);
    });

    it('#then a step outside the window is rejected', () => {
      const stale = totpCode(RFC_SECRET, at - 120_000);
      expect(
        verifyTotpCode({ secret: RFC_SECRET, code: stale, atMs: at }),
      ).toEqual({ ok: false, reason: 'mismatch' });
    });
  });

  describe('#given a previously accepted step', () => {
    const at = 1_111_111_109_000;
    const code = totpCode(RFC_SECRET, at);

    it('#then the same step is rejected as a replay', () => {
      expect(
        verifyTotpCode({
          secret: RFC_SECRET,
          code,
          atMs: at,
          lastStep: totpStep(at),
        }),
      ).toEqual({ ok: false, reason: 'replay' });
    });

    it('#then an older step is rejected as a replay', () => {
      expect(
        verifyTotpCode({
          secret: RFC_SECRET,
          code,
          atMs: at,
          lastStep: totpStep(at) + 1n,
        }),
      ).toEqual({ ok: false, reason: 'replay' });
    });

    it('#then a newer step is accepted', () => {
      const next = totpCode(RFC_SECRET, at + 30_000);
      expect(
        verifyTotpCode({
          secret: RFC_SECRET,
          code: next,
          atMs: at + 30_000,
          lastStep: totpStep(at),
        }).ok,
      ).toBe(true);
    });
  });

  describe('#given malformed input', () => {
    it('#then a non-six-digit code is rejected before any comparison', () => {
      expect(verifyTotpCode({ secret: RFC_SECRET, code: '12345' })).toEqual({
        ok: false,
        reason: 'format',
      });
      expect(verifyTotpCode({ secret: RFC_SECRET, code: 'abcdef' })).toEqual({
        ok: false,
        reason: 'format',
      });
      expect(verifyTotpCode({ secret: RFC_SECRET, code: '12 345' })).toEqual({
        ok: false,
        reason: 'format',
      });
    });
  });

  describe('#given the enrolment URI', () => {
    it('#then it is a scannable otpauth URI', () => {
      const uri = buildTotpUri({
        secret: RFC_SECRET,
        accountName: 'ops@example.com',
      });

      expect(uri).toBe(
        'otpauth://totp/Inverge%20Admin%3Aops%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Inverge+Admin&algorithm=SHA1&digits=6&period=30',
      );
    });
  });
});
