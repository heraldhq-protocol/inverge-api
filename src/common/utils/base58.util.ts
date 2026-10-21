// Minimal base58 (Bitcoin alphabet) decoder. Solana addresses are the base58
// encoding of a 32-byte ed25519 public key, so decoding lets us compare an
// address a client claims with the key a provider signed — without trusting the
// claimed address itself.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DIGITS = new Map<string, number>([...ALPHABET].map((char, index) => [char, index]));

/**
 * Decodes a base58 string to bytes. Leading '1' characters encode leading zero
 * bytes, matching the Bitcoin/Solana alphabet convention.
 *
 * @throws Error when the value contains a character outside the alphabet.
 */
export function base58ToBytes(value: string): Uint8Array {
  const bytes: number[] = [];

  for (const char of value) {
    const digit = DIGITS.get(char);
    if (digit === undefined) throw new Error(`Invalid base58 character: ${char}`);

    let carry = digit;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (let i = 0; i < value.length && value[i] === '1'; i++) bytes.push(0);

  return Uint8Array.from(bytes.reverse());
}

/** Hex encoding of a base58 value (lower-case, no `0x` prefix). */
export function base58ToHex(value: string): string {
  return Buffer.from(base58ToBytes(value)).toString('hex');
}
