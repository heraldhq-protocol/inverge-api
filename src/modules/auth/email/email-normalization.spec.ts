import { MAX_EMAIL_LENGTH, normalizeEmail } from './email-normalization';

describe('normalizeEmail', () => {
  it('trims and lower-cases a valid address', () => {
    expect(normalizeEmail('  Ada.Lovelace@Example.COM  ')).toBe(
      'ada.lovelace@example.com',
    );
  });

  it('rejects missing, blank and non-string values', () => {
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });

  it('rejects structurally invalid addresses', () => {
    for (const value of [
      'ada',
      'ada@',
      '@example.com',
      'ada@@example.com',
      'ada@example',
      'ada@.com',
      'ada@example..com',
      'ada example@example.com',
      'ada@exa mple.com',
      'ada\u0000@example.com',
    ]) {
      expect(normalizeEmail(value)).toBeNull();
    }
  });

  it('enforces the stored maximum length', () => {
    const local = 'a'.repeat(MAX_EMAIL_LENGTH - '@example.com'.length);
    expect(normalizeEmail(`${local}@example.com`)).not.toBeNull();
    expect(normalizeEmail(`a${local}@example.com`)).toBeNull();
  });
});
