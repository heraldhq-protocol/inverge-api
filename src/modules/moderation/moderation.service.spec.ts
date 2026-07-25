import { ModerationService } from './moderation.service';
import { AML_GENERIC_EXTERNAL } from './moderation-routing';
import { CategoryFinding, POLICY_VERSION } from '../../ports/moderation/moderation.port';

function setup(categories: CategoryFinding[], opts: { threshold?: number; provider?: string } = {}) {
  const maxRisk = categories.reduce((m, c) => Math.max(m, c.riskScore), 0);
  const classifier = {
    classify: jest.fn().mockResolvedValue({
      categories,
      maxRisk,
      policyVersion: POLICY_VERSION,
      provider: opts.provider ?? 'stub',
    }),
  } as any;
  const prisma = {
    moderationCase: { create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'case1', ...data })) },
  } as any;
  const params = { getNumber: jest.fn(async (_k: string, fb = 0) => opts.threshold ?? fb) } as any;
  return { svc: new ModerationService(classifier, prisma, params), classifier, prisma };
}

const cat = (code: string, riskScore: number, draftReason = 'reframe'): CategoryFinding =>
  ({ code: code as any, riskScore, excerpt: 'span', draftReason });

const content = { kind: 'idea' as const, title: 'X', text: 'some pitch text' };

describe('ModerationService.screen (harness)', () => {
  it('auto-clears a clean submission and records the case', async () => {
    const { svc, prisma } = setup([], { threshold: 0.5 });
    const c = await svc.screen(content, { ideaId: 'idea1', submittedById: 'u1' });
    expect(c.decision).toBe('AUTO_CLEAR');
    expect(c.reasonCodes).toEqual([]);
    expect(c.externalReason).toBe('');
    const data = prisma.moderationCase.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ kind: 'idea', ideaId: 'idea1', submittedById: 'u1', policyVersion: POLICY_VERSION });
  });

  it('holds a submission with a category at/above threshold', async () => {
    const { svc } = setup([cat('POL-SEC', 0.9, 'Remove ROI language.')], { threshold: 0.5 });
    const c = await svc.screen(content);
    expect(c.decision).toBe('HELD_FOR_REVIEW');
    expect(c.reasonCodes).toContain('POL-SEC');
    expect(c.externalReason).toBe('Remove ROI language.');
  });

  it('ignores a below-threshold flag (auto-clear)', async () => {
    const { svc } = setup([cat('POL-MIS', 0.3)], { threshold: 0.5 });
    expect((await svc.screen(content)).decision).toBe('AUTO_CLEAR');
  });

  it('L1: a banned submitter is held even when L2 is clean', async () => {
    const { svc } = setup([], { threshold: 0.5 });
    const c = await svc.screen(content, { submitterBanned: true });
    expect(c.decision).toBe('HELD_FOR_REVIEW');
    expect(c.reasonCodes).toContain('L1-SUBMITTER-BANNED');
  });

  it('AML tipping-off: external reason stays generic, internal keeps detail (D2/FR-1007)', async () => {
    const { svc } = setup([cat('POL-AML', 0.8, 'structuring pattern')], { threshold: 0.5 });
    const c = await svc.screen(content);
    expect(c.externalReason).toBe(AML_GENERIC_EXTERNAL);
    expect(c.internalReason).toMatch(/POL-AML/);
  });

  it('never auto-rejects even at max risk (D1)', async () => {
    const { svc } = setup([cat('POL-CAT', 1)], { threshold: 0.5 });
    expect((await svc.screen(content)).decision).toBe('HELD_FOR_REVIEW');
  });

  it('records the classifier provenance', async () => {
    const { svc } = setup([], { threshold: 0.5, provider: 'ai:deepseek-v4-pro' });
    expect((await svc.screen(content)).provider).toBe('ai:deepseek-v4-pro');
  });
});

describe('ModerationService.screenSafe (non-blocking)', () => {
  it('swallows classifier errors and returns null', async () => {
    const { svc, classifier } = setup([], { threshold: 0.5 });
    classifier.classify.mockRejectedValue(new Error('upstream 500'));
    expect(await svc.screenSafe(content)).toBeNull();
  });
});
