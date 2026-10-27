import { createHash } from 'node:crypto';
import {
  CAMPAIGN_ACCOUNT_DISCRIMINATOR,
  CAMPAIGN_ACCOUNT_SIZE,
  CREATE_CAMPAIGN_DISCRIMINATOR,
  MINT_ACCOUNT_SIZE,
  anchorDiscriminator,
  decodeCampaignAccount,
  decodeCreateCampaignInstruction,
  decodeMintDecimals,
  encodeCreateCampaignInstruction,
  type CreateCampaignArgs,
} from './anchor-escrow';

const TERMS_HASH = 'a'.repeat(64);
const EVIDENCE = 'b'.repeat(64);

function args(overrides: Partial<CreateCampaignArgs> = {}): CreateCampaignArgs {
  return {
    campaignId: Buffer.alloc(32, 7),
    customFeeBps: null,
    deadline: 1_800_000_000,
    floorAmount: 5_000_000_000n,
    milestones: [
      { deadline: 1_800_100_000, evidenceHash: EVIDENCE, trancheBps: 5_000 },
      { deadline: 1_800_200_000, evidenceHash: EVIDENCE, trancheBps: 5_000 },
    ],
    targetAmount: 5_000_000_000n,
    termsHash: TERMS_HASH,
    workingCapitalBps: 2_000,
    ...overrides,
  };
}

function buildCampaignAccount(): Buffer {
  const buffer = Buffer.alloc(CAMPAIGN_ACCOUNT_SIZE);
  Buffer.from(CAMPAIGN_ACCOUNT_DISCRIMINATOR).copy(buffer, 0);
  let offset = 8;

  const write = (bytes: Buffer) => {
    bytes.copy(buffer, offset);
    offset += bytes.length;
  };
  const u8 = (value: number) => {
    buffer.writeUInt8(value, offset);
    offset += 1;
  };
  const u16 = (value: number) => {
    buffer.writeUInt16LE(value, offset);
    offset += 2;
  };
  const u64 = (value: bigint) => {
    buffer.writeBigUInt64LE(value, offset);
    offset += 8;
  };
  const i64 = (value: number) => {
    buffer.writeBigInt64LE(BigInt(value), offset);
    offset += 8;
  };

  write(Buffer.alloc(32, 1)); // campaign id
  write(Buffer.alloc(32, 2)); // creator
  write(Buffer.alloc(32, 3)); // token mint
  write(Buffer.alloc(32, 4)); // escrow vault
  u64(9_000_000_000n);
  u64(9_000_000_000n);
  i64(1_800_000_000);
  write(Buffer.from(TERMS_HASH, 'hex'));
  u8(0); // Funding
  u64(0n);
  u64(0n);
  u64(0n);
  u16(2_000);
  u16(500);
  u8(0);
  u8(2); // milestone count

  for (let index = 0; index < 6; index += 1) {
    const active = index < 2;
    u16(active ? 4_000 : 0);
    write(Buffer.alloc(32, active ? 5 : 0));
    write(Buffer.alloc(32, 0));
    u8(0);
    i64(active ? 1_800_100_000 + index : 0);
    i64(0);
    i64(0);
    i64(0);
    u64(0n);
  }

  u8(255);
  u8(254);
  return buffer;
}

describe('anchor escrow encoding', () => {
  it('matches the Anchor discriminators derived from sha256("namespace:name")', () => {
    // #given the Anchor namespace/name convention
    // #when the discriminator is derived
    // #then the first eight sha256 bytes are used, and the fixtures stay stable
    expect(Buffer.from(anchorDiscriminator('global', 'create_campaign')).toString('hex')).toBe(
      '6f83bb62a0c172f4',
    );
    expect(Buffer.from(CREATE_CAMPAIGN_DISCRIMINATOR).toString('hex')).toBe('6f83bb62a0c172f4');
    expect(Buffer.from(CAMPAIGN_ACCOUNT_DISCRIMINATOR).toString('hex')).toBe('3228310b9ddce5c0');
    expect(createHash('sha256').update('account:Campaign').digest().subarray(0, 8)).toEqual(
      Buffer.from(CAMPAIGN_ACCOUNT_DISCRIMINATOR),
    );
  });

  it('round-trips every encoded argument, including milestone field order', () => {
    // #given a fully populated create_campaign instruction
    // #when it is encoded and decoded
    // #then every field survives, and milestones keep tranche/evidence/deadline order
    const encoded = encodeCreateCampaignInstruction(args());

    const decoded = decodeCreateCampaignInstruction(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded?.campaignId).toBe(Buffer.alloc(32, 7).toString('hex'));
    expect(decoded?.targetAmount).toBe(5_000_000_000n);
    expect(decoded?.floorAmount).toBe(5_000_000_000n);
    expect(decoded?.deadline).toBe(1_800_000_000);
    expect(decoded?.termsHash).toBe(TERMS_HASH);
    expect(decoded?.workingCapitalBps).toBe(2_000);
    expect(decoded?.customFeeBps).toBeNull();
    expect(decoded?.milestones).toEqual([
      { deadline: 1_800_100_000, evidenceHash: EVIDENCE, trancheBps: 5_000 },
      { deadline: 1_800_200_000, evidenceHash: EVIDENCE, trancheBps: 5_000 },
    ]);
  });

  it('encodes an explicit custom fee when one is supplied', () => {
    // #given a custom fee override
    const encoded = encodeCreateCampaignInstruction(args({ customFeeBps: 250 }));

    // #when decoded
    // #then the option marker and value are both present
    expect(decodeCreateCampaignInstruction(encoded)?.customFeeBps).toBe(250);
  });

  it('returns null for data that is not a create_campaign instruction', () => {
    // #given arbitrary bytes
    // #when decoded
    // #then it is rejected rather than misread
    expect(decodeCreateCampaignInstruction(Buffer.from('not-an-instruction'))).toBeNull();
  });

  it.each([
    ['too few milestones', args({ milestones: [] })],
    ['too many milestones', args({ milestones: Array.from({ length: 7 }, () => ({ deadline: 1, evidenceHash: EVIDENCE, trancheBps: 1_000 })) })],
    ['a tranche above u16', args({ workingCapitalBps: 70_000 })],
    ['a non-positive target', args({ targetAmount: 0n })],
    ['a malformed terms hash', args({ termsHash: 'abc' })],
  ])('rejects %s instead of truncating it', (_label, input) => {
    // #given an out-of-range argument
    // #when encoded
    // #then it throws rather than writing a different number
    expect(() => encodeCreateCampaignInstruction(input)).toThrow();
  });
});

describe('campaign account decoding', () => {
  it('decodes the Rust Campaign layout', () => {
    // #given an account serialised with the documented layout
    // #when decoded
    // #then the fields and milestone count match, and the size assumption holds
    const data = buildCampaignAccount();

    const decoded = decodeCampaignAccount(data);

    expect(data.length).toBe(CAMPAIGN_ACCOUNT_SIZE);
    expect(decoded?.termsHash).toBe(TERMS_HASH);
    expect(decoded?.targetAmount).toBe(9_000_000_000n);
    expect(decoded?.workingCapitalBps).toBe(2_000);
    expect(decoded?.feeBps).toBe(500);
    expect(decoded?.milestoneCount).toBe(2);
    expect(decoded?.milestones).toHaveLength(2);
    expect(decoded?.milestones[1]?.trancheBps).toBe(4_000);
    expect(decoded?.milestones[1]?.deadline).toBe(1_800_100_001);
    expect(decoded?.bump).toBe(255);
    expect(decoded?.vaultBump).toBe(254);
  });

  it('returns null when the discriminator belongs to another account type', () => {
    // #given a buffer with a foreign discriminator
    const data = buildCampaignAccount();
    data.write('ffffffff', 0, 'hex');

    // #when decoded
    // #then it is reported as "not a Campaign", not as corrupt
    expect(decodeCampaignAccount(data)).toBeNull();
  });

  it('throws on a truncated account rather than returning partial terms', () => {
    // #given a truncated Campaign account
    // #when decoded
    // #then decoding fails loudly
    expect(() => decodeCampaignAccount(buildCampaignAccount().subarray(0, 120))).toThrow(
      'truncated',
    );
  });
});

describe('mint decimals decoding', () => {
  function mint(decimals: number, initialized = 1): Buffer {
    const data = Buffer.alloc(MINT_ACCOUNT_SIZE);
    data.writeUInt8(decimals, 44);
    data.writeUInt8(initialized, 45);
    return data;
  }

  it('reads the exponent from byte 44', () => {
    // #given an initialised 6-decimal mint
    // #when decoded
    // #then the exponent is six
    expect(decodeMintDecimals(mint(6))).toBe(6);
  });

  it('returns null for an uninitialised or non-mint account', () => {
    // #given an uninitialised account and a short buffer
    // #when decoded
    // #then neither yields a guessed exponent
    expect(decodeMintDecimals(mint(6, 0))).toBeNull();
    expect(decodeMintDecimals(Buffer.alloc(10))).toBeNull();
  });
});
