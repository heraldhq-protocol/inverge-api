import {
  generateVerificationCode,
  hashVerificationCode,
  parseVerificationCode,
  verificationCodeMatches,
} from './email-code';

describe('email verification codes', () => {
  it('generates exactly six digits, including leading zeroes', () => {
    // #given many samples
    const codes = Array.from({ length: 200 }, generateVerificationCode);

    // #then every code is numeric, six characters and within the whole space
    for (const code of codes) {
      expect(code).toMatch(/^\d{6}$/);
    }
    expect(new Set(codes).size).toBeGreaterThan(1);
  });

  it('accepts surrounding whitespace but rejects anything else', () => {
    // #given valid and invalid client input
    expect(parseVerificationCode(' 123456 ')).toBe('123456');
    expect(parseVerificationCode('12345')).toBeNull();
    expect(parseVerificationCode('1234567')).toBeNull();
    expect(parseVerificationCode('12345a')).toBeNull();
    expect(parseVerificationCode(123456)).toBeNull();
  });

  it('binds the hash to both the code and the challenge id', () => {
    // #given one code and two challenges
    const secret = 'test-secret-that-is-long-enough';
    const first = hashVerificationCode(secret, 'challenge-a', '123456');
    const same = hashVerificationCode(secret, 'challenge-a', '123456');
    const otherChallenge = hashVerificationCode(secret, 'challenge-b', '123456');
    const otherCode = hashVerificationCode(secret, 'challenge-a', '654321');

    // #then only the same pair reproduces the digest
    expect(first).toBe(same);
    expect(first).not.toBe(otherChallenge);
    expect(first).not.toBe(otherCode);
    expect(first).not.toContain('123456');
  });

  it('compares in constant time and rejects malformed stored hashes', () => {
    // #given a matching digest
    const secret = 'test-secret-that-is-long-enough';
    const digest = hashVerificationCode(secret, 'challenge-a', '123456');

    // #then only the right code matches
    expect(
      verificationCodeMatches(digest, secret, 'challenge-a', '123456'),
    ).toBe(true);
    expect(
      verificationCodeMatches(digest, secret, 'challenge-a', '000000'),
    ).toBe(false);
    expect(
      verificationCodeMatches(digest, secret, 'challenge-b', '123456'),
    ).toBe(false);
    expect(
      verificationCodeMatches('not-hex', secret, 'challenge-a', '123456'),
    ).toBe(false);
  });
});
