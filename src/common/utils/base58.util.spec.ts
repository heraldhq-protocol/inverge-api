import { base58ToBytes, base58ToHex } from './base58.util';

describe('base58', () => {
  it('decodes a single leading-zero character to one zero byte', () => {
    expect(Array.from(base58ToBytes('1'))).toEqual([0]);
  });

  it('decodes consecutive leading zeros to the same number of zero bytes', () => {
    expect(Array.from(base58ToBytes('111'))).toEqual([0, 0, 0]);
  });

  it('decodes the smallest non-zero values', () => {
    expect(Array.from(base58ToBytes('2'))).toEqual([1]);
    expect(Array.from(base58ToBytes('z'))).toEqual([57]);
  });

  it('decodes a 32-byte all-zero Solana key', () => {
    const bytes = base58ToBytes('11111111111111111111111111111111');
    expect(bytes).toHaveLength(32);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('returns lower-case hex without a prefix', () => {
    expect(base58ToHex('2')).toBe('01');
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base58ToBytes('0OIl')).toThrow('Invalid base58 character');
  });

  it('returns no bytes for an empty value', () => {
    expect(Array.from(base58ToBytes(''))).toEqual([]);
  });
});
