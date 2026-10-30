import 'dotenv/config';
import { AiModerationAdapter } from '../src/ports/moderation/ai-moderation.adapter';

// LIVE test against the Anthropic-compatible endpoint (AI_BASE_URL → DeepSeek).
// Opt-in only: a developer .env with a key must not make the default e2e run depend
// on a vendor outage, latency or model output. Set RUN_LIVE_AI_E2E=true to enable.
const RUN = process.env.RUN_LIVE_AI_E2E === 'true' && !!process.env.AI_API_KEY;
const d = RUN ? describe : describe.skip;

// Minimal ConfigService shim reading from the loaded .env.
const configStub = {
  get: (k: string) => process.env[k],
} as any;

d('AI moderation classifier — live (FR-1003 Layer 2)', () => {
  const svc = new AiModerationAdapter(configStub);
  jest.setTimeout(60_000);

  const sec = (r: Awaited<ReturnType<AiModerationAdapter['classify']>>) =>
    r.categories.find((c) => c.code === 'POL-SEC');

  it('flags a returns-promising pitch as POL-SEC', async () => {
    const r = await svc.classify({
      kind: 'idea',
      title: 'AgriYield Fund',
      text:
        'Back our farm and earn a guaranteed 15% monthly return on your money. ' +
        'Every backer gets a profit share and dividends paid out quarterly — your capital works for you.',
    });
    console.log('  returns-pitch →', JSON.stringify({ maxRisk: r.maxRisk, provider: r.provider, cats: r.categories.map((c) => `${c.code}:${c.riskScore}`) }));
    expect(sec(r)).toBeDefined();
    expect(sec(r)!.riskScore).toBeGreaterThanOrEqual(0.5);
    expect(r.provider).toMatch(/^ai:/);
  });

  it('does NOT strongly flag a benign reward-based pitch as POL-SEC', async () => {
    const r = await svc.classify({
      kind: 'idea',
      title: 'Kilishi Cold-Chain Co-op',
      text:
        'Solar cold-chain lockers for kilishi producers in Kano, rented per tray. ' +
        'Backers pre-order kilishi boxes as a reward once the first locker is live. No money moves now.',
    });
    console.log('  benign-pitch  →', JSON.stringify({ maxRisk: r.maxRisk, provider: r.provider, cats: r.categories.map((c) => `${c.code}:${c.riskScore}`) }));
    const s = sec(r);
    expect(!s || s.riskScore < 0.5).toBe(true);
  });
});
