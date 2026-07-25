import { scoreCompleteness, StubQualityScorerAdapter } from './stub-quality-scorer.adapter';
import { ScorableIdea } from './quality-scorer.port';

const complete: ScorableIdea = {
  title: 'AgriDrone',
  problem: 'Smallholder farmers lack credit history so lenders reject them.',
  solution: 'Drone + satellite yield estimates become an alt-credit score for banks.',
  targetUser: 'smallholder maize farmers in Kaduna',
  currentAlternative: 'lenders rely on manual visits, which are slow and rarely happen.',
  askBreakdown: { drones: 8000, staff: 12000 },
  roadmapSteps: [
    { date: '2026-Q1', description: 'pilot 200 farms' },
    { date: '2026-Q2', description: 'lender API live' },
  ],
  category: 'agriculture',
};

describe('scoreCompleteness (deterministic FR-271)', () => {
  it('scores a fully-structured pitch at 1.0', () => {
    const r = scoreCompleteness(complete);
    expect(r.score).toBe(1);
    expect(r.checks.every((c) => c.passed)).toBe(true);
  });

  it('reports AI-only checks as skipped (excluded from the score)', () => {
    const r = scoreCompleteness(complete);
    expect(r.skipped).toEqual(expect.arrayContaining(['content.substantive', 'content.original', 'ask.coherence']));
    expect(r.checks.every((c) => c.kind === 'deterministic')).toBe(true);
  });

  it('fails the targetUser check when it is vague/empty, with coaching', () => {
    const r = scoreCompleteness({ ...complete, targetUser: '' });
    const check = r.checks.find((c) => c.id === 'targetUser.specific')!;
    expect(check.passed).toBe(false);
    expect(check.message).toMatch(/target user/i);
    expect(r.score).toBeCloseTo(5 / 6, 4);
  });

  it('requires at least two dated roadmap steps', () => {
    const oneStep = scoreCompleteness({ ...complete, roadmapSteps: [{ date: '2026', description: 'x' }] });
    expect(oneStep.checks.find((c) => c.id === 'roadmap.datedSteps')!.passed).toBe(false);
    const undated = scoreCompleteness({ ...complete, roadmapSteps: [{ description: 'a' }, { description: 'b' }] });
    expect(undated.checks.find((c) => c.id === 'roadmap.datedSteps')!.passed).toBe(false);
  });

  it('rejects an empty ask breakdown', () => {
    expect(scoreCompleteness({ ...complete, askBreakdown: {} }).checks.find((c) => c.id === 'askBreakdown.present')!.passed).toBe(false);
    expect(scoreCompleteness({ ...complete, askBreakdown: [] }).checks.find((c) => c.id === 'askBreakdown.present')!.passed).toBe(false);
    expect(scoreCompleteness({ ...complete, askBreakdown: { a: 1 } }).checks.find((c) => c.id === 'askBreakdown.present')!.passed).toBe(true);
  });

  it('an empty pitch scores 0', () => {
    const r = scoreCompleteness({ title: '', problem: '', solution: '', targetUser: '', currentAlternative: '', askBreakdown: null, roadmapSteps: null, category: null });
    expect(r.score).toBe(0);
  });

  it('the adapter delegates to the pure scorer', async () => {
    const r = await new StubQualityScorerAdapter().score(complete);
    expect(r.score).toBe(1);
  });
});
