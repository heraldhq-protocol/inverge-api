import { keywordClassify } from './stub-moderation.adapter';
import { parseFindings } from './ai-moderation.adapter';

const find = (r: ReturnType<typeof keywordClassify>, code: string) =>
  r.categories.find((c) => c.code === code);

describe('keywordClassify (stub FR-1003)', () => {
  it('flags POL-SEC on returns/ROI language with an excerpt + draft reason', () => {
    const r = keywordClassify({
      kind: 'idea',
      title: 'Solar Co-op',
      text: 'Back us and earn guaranteed returns of 20% monthly — your money works for you.',
    });
    const sec = find(r, 'POL-SEC');
    expect(sec).toBeDefined();
    expect(sec!.riskScore).toBeGreaterThanOrEqual(0.7);
    expect(sec!.excerpt).toMatch(/guaranteed returns/i);
    expect(sec!.draftReason).toMatch(/return|investment|reward/i);
    expect(r.maxRisk).toBeGreaterThanOrEqual(0.7);
  });

  it('flags POL-CAT on prohibited categories (token launch, weapons, MLM)', () => {
    expect(find(keywordClassify({ kind: 'idea', text: 'A presale of our token launch / ICO.' }), 'POL-CAT')).toBeDefined();
    expect(find(keywordClassify({ kind: 'idea', text: 'Manufacture firearms and ammunition.' }), 'POL-CAT')).toBeDefined();
    expect(find(keywordClassify({ kind: 'idea', text: 'Join our multi-level marketing downline!' }), 'POL-CAT')).toBeDefined();
  });

  it('clears a benign reward-based pitch (no POL-SEC/POL-CAT)', () => {
    const r = keywordClassify({
      kind: 'idea',
      title: 'Kilishi Cold-Chain Co-op',
      text: 'Solar cold-chain lockers for kilishi producers; backers pre-order kilishi boxes as a reward.',
    });
    expect(find(r, 'POL-SEC')).toBeUndefined();
    expect(find(r, 'POL-CAT')).toBeUndefined();
    expect(r.maxRisk).toBe(0);
  });

  it('caps risk at 1 and always stamps the policy version', () => {
    const r = keywordClassify({
      kind: 'idea',
      text: 'guaranteed returns, 30% monthly returns, 10x your money, ROI, dividends, invest now',
    });
    expect(find(r, 'POL-SEC')!.riskScore).toBeLessThanOrEqual(1);
    expect(r.policyVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.provider).toBe('stub');
  });
});

describe('parseFindings (AI response parser)', () => {
  it('parses a bare JSON array', () => {
    const out = parseFindings('[{"code":"POL-SEC","riskScore":0.9,"excerpt":"20% ROI","draftReason":"reframe"}]');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: 'POL-SEC', riskScore: 0.9, excerpt: '20% ROI' });
  });

  it('extracts JSON from code fences and surrounding prose', () => {
    const text = 'Here are the findings:\n```json\n[{"code":"POL-CAT","riskScore":0.6}]\n```\nDone.';
    const out = parseFindings(text);
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe('POL-CAT');
    expect(out[0].excerpt).toBeNull();
  });

  it('drops unknown codes and clamps out-of-range risk', () => {
    const out = parseFindings('[{"code":"POL-XYZ","riskScore":0.5},{"code":"POL-MIS","riskScore":5}]');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: 'POL-MIS', riskScore: 1 });
  });

  it('returns [] on empty findings or unparseable text', () => {
    expect(parseFindings('[]')).toEqual([]);
    expect(parseFindings('the model refused to answer')).toEqual([]);
    expect(parseFindings('[not valid json')).toEqual([]);
  });
});
