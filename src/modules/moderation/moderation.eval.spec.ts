import { keywordClassify } from '../../ports/moderation/stub-moderation.adapter';
import { route } from './moderation-routing';

// Labeled evaluation battery for the moderation harness (deterministic stub classifier +
// routing). Measures recall on policy-violating samples and specificity on benign ones —
// the calibration rig behind NFR-18 (recall over precision). Swap the classifier for the
// AI adapter to score DeepSeek against the same battery.
const THRESHOLD = 0.5;

interface Sample {
  label: 'held' | 'clear';
  expect?: string; // expected policy code on a held sample
  text: string;
}

const BATTERY: Sample[] = [
  // Policy-violating → must HOLD
  { label: 'held', expect: 'POL-SEC', text: 'Back us and earn guaranteed returns of 20% monthly — your money works for you.' },
  { label: 'held', expect: 'POL-SEC', text: 'Every backer receives a profit share and dividends paid quarterly.' },
  { label: 'held', expect: 'POL-CAT', text: 'Join the presale of our token launch / ICO before the price goes up.' },
  { label: 'held', expect: 'POL-CAT', text: 'We manufacture firearms and ammunition for licensed dealers.' },
  { label: 'held', expect: 'POL-CAT', text: 'Join our multi-level marketing downline and recruit your friends.' },
  // Benign reward-based pitches → must CLEAR
  { label: 'clear', text: 'Solar cold-chain lockers for kilishi producers in Kano; backers pre-order kilishi boxes as a reward.' },
  { label: 'clear', text: 'A drone credit-scoring tool for smallholder farmers; lenders underwrite loans using yield estimates.' },
  { label: 'clear', text: 'A community library app that lets rural schools share e-books offline.' },
  { label: 'clear', text: 'Handmade leather sandals from Kano artisans; backers receive a pair once we hit our first milestone.' },
];

function screen(text: string) {
  const result = keywordClassify({ kind: 'idea', text });
  const flagged = result.categories.filter((c) => c.riskScore >= THRESHOLD).map((c) => c.code);
  const decision = route(true, [], flagged).decision;
  return { decision, flagged };
}

describe('moderation eval battery (recall / specificity)', () => {
  const held = BATTERY.filter((s) => s.label === 'held');
  const clear = BATTERY.filter((s) => s.label === 'clear');

  it.each(held)('HOLDS a policy-violating sample: %o', (s) => {
    const { decision, flagged } = screen(s.text);
    expect(decision).toBe('HELD_FOR_REVIEW');
    if (s.expect) expect(flagged).toContain(s.expect);
  });

  it.each(clear)('CLEARS a benign sample: %o', (s) => {
    expect(screen(s.text).decision).toBe('AUTO_CLEAR');
  });

  it('reports 100% recall and specificity on the battery', () => {
    const recall = held.filter((s) => screen(s.text).decision === 'HELD_FOR_REVIEW').length / held.length;
    const specificity = clear.filter((s) => screen(s.text).decision === 'AUTO_CLEAR').length / clear.length;
    console.log(`  moderation eval → recall=${recall.toFixed(2)} specificity=${specificity.toFixed(2)} (n=${BATTERY.length})`);
    expect(recall).toBe(1);
    expect(specificity).toBe(1);
  });
});
