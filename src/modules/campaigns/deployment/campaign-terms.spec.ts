import {
  CAMPAIGN_ID_VERSION,
  CAMPAIGN_TERMS_VERSION,
  campaignIdBytes,
  campaignIdHex,
  campaignTermsHash,
  canonicalCampaignTerms,
  stableJson,
  toAtomicUnits,
} from './campaign-terms';

describe('toAtomicUnits', () => {
  it('scales by the mint exponent without floating point', () => {
    // #given whole and fractional amounts for a 6-decimal mint
    // #when converted
    // #then every digit is preserved
    expect(toAtomicUnits('5000', 6)).toBe(5_000_000_000n);
    expect(toAtomicUnits('0.000001', 6)).toBe(1n);
    expect(toAtomicUnits('12.34', 6)).toBe(12_340_000n);
    expect(toAtomicUnits(1234.5, 2)).toBe(123_450n);
  });

  it('rejects precision the mint cannot represent', () => {
    // #given more decimal places than the mint allows
    // #when converted
    // #then it throws instead of rounding money
    expect(() => toAtomicUnits('1.005', 2)).toThrow('more decimal places');
  });

  it.each(['-1', '1e6', '', '1,000', '0x10'])('rejects %p', (value) => {
    expect(() => toAtomicUnits(value, 6)).toThrow();
  });

  it('rejects an invalid exponent', () => {
    expect(() => toAtomicUnits('1', -1)).toThrow('Invalid mint decimals');
    expect(() => toAtomicUnits('1', 19)).toThrow('Invalid mint decimals');
  });
});

describe('stableJson', () => {
  it('is independent of object key order and drops undefined', () => {
    // #given the same document with keys inserted in different orders
    const a = { b: 1, a: [1, undefined, { d: 2, c: 3 }] };
    const b = { a: [1, null, { c: 3, d: 2 }], b: 1 };

    // #when canonicalised
    // #then both produce identical bytes
    expect(stableJson(a)).toBe(stableJson(b));
  });

  it('refuses non-finite numbers rather than hashing them as null', () => {
    expect(() => stableJson({ value: Number.POSITIVE_INFINITY })).toThrow('non-finite');
  });
});

describe('campaign terms hash', () => {
  const input = {
    campaignId: 'cmp_1',
    creatorId: 'user_1',
    deadline: '2026-12-01T00:00:00.000Z',
    milestones: [
      {
        deliverable: 'Pilot',
        evidence: 'Signed agreement',
        expectedAt: '2026-11-15T00:00:00.000Z',
        index: 0,
        title: 'Pilot',
        trancheBps: 10_000,
      },
    ],
    objectionWindowDays: 7,
    rewardTiers: null,
    story: { location: 'Lagos' },
    summary: 'Summary',
    targetAmountAtomic: '5000000000',
    title: 'Solar',
    tokenType: 'USDC',
    workingCapitalBps: 2_000,
  };

  it('includes the version and every backer-relevant field', () => {
    const canonical = canonicalCampaignTerms(input);

    expect(canonical.version).toBe(CAMPAIGN_TERMS_VERSION);
    expect(canonical.targetAmountAtomic).toBe('5000000000');
    expect(canonical.workingCapitalBps).toBe(2_000);
  });

  it('is stable for equal content presented in a different key order', () => {
    // #given two equivalent documents
    const reordered = {
      ...input,
      milestones: [{ ...input.milestones[0]!, title: 'Pilot', deliverable: 'Pilot' }],
      story: { location: 'Lagos' },
    };

    // #when hashed
    // #then the hash is identical
    expect(campaignTermsHash(reordered)).toBe(campaignTermsHash(input));
  });

  it('changes when any committed term changes', () => {
    // #given a single edited field
    // #when hashed
    // #then the on-chain commitment changes
    expect(campaignTermsHash({ ...input, title: 'Solar v2' })).not.toBe(campaignTermsHash(input));
    expect(campaignTermsHash({ ...input, workingCapitalBps: 2_100 })).not.toBe(
      campaignTermsHash(input),
    );
  });
});

describe('campaign id derivation', () => {
  it('is a domain-separated 32-byte value', () => {
    // #given an internal campaign id
    const bytes = campaignIdBytes('cmp_1');

    // #when derived
    // #then it is 32 bytes, hex is stable, and the version is part of the input
    expect(bytes).toHaveLength(32);
    expect(campaignIdHex('cmp_1')).toBe(Buffer.from(bytes).toString('hex'));
    expect(campaignIdHex('cmp_1')).not.toBe(campaignIdHex('cmp_2'));
    expect(CAMPAIGN_ID_VERSION).toBe('inverge.campaign-id.v1');
  });

  it('rejects an empty id', () => {
    expect(() => campaignIdBytes('')).toThrow();
  });
});
