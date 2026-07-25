import { NotFoundException } from '@nestjs/common';
import { QualityService } from './quality.service';

function setup(opts: { score: number; tier?: string; floor?: number }) {
  const scorer = {
    score: jest.fn().mockResolvedValue({
      score: opts.score,
      checks: [{ id: 'x', passed: opts.score >= 1, weight: 1, kind: 'deterministic', message: 'm' }],
      skipped: ['content.original'],
    }),
  } as any;
  const prisma = {
    idea: {
      findUnique: jest.fn().mockResolvedValue({ discoverabilityTier: opts.tier ?? 'LINK_ONLY' }),
      update: jest.fn().mockResolvedValue({}),
    },
    ideaQualityReport: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn() },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  } as any;
  const params = { getNumber: jest.fn(async (_k: string, fb = 0) => opts.floor ?? fb) } as any;
  return { svc: new QualityService(scorer, prisma, params), scorer, prisma };
}

describe('QualityService.evaluate (FR-271/272)', () => {
  it('promotes to DISCOVERABLE when the score clears the floor', async () => {
    const { svc, prisma } = setup({ score: 0.83, floor: 0.7 });
    const res = await svc.evaluate('idea1', true);
    expect(res.tier).toBe('DISCOVERABLE');
    const update = prisma.idea.update.mock.calls[0][0].data;
    expect(update.discoverabilityTier).toBe('DISCOVERABLE');
    expect(Number(update.qualityScore)).toBe(0.83);
    expect(prisma.ideaQualityReport.create).toHaveBeenCalled(); // audit + coaching stored
  });

  it('stays LINK_ONLY below the floor — never rejects (FR-271a)', async () => {
    const { svc, prisma } = setup({ score: 0.5, floor: 0.7 });
    const res = await svc.evaluate('idea1', true);
    expect(res.tier).toBe('LINK_ONLY');
    expect(prisma.idea.update.mock.calls[0][0].data.discoverabilityTier).toBe('LINK_ONLY');
  });

  it('never demotes an editorial FEATURED idea', async () => {
    const { svc } = setup({ score: 0.1, floor: 0.7, tier: 'FEATURED' });
    expect((await svc.evaluate('idea1', true)).tier).toBe('FEATURED');
  });

  it('applyTier=false stores the score but does not touch the tier', async () => {
    const { svc, prisma } = setup({ score: 0.9, floor: 0.7, tier: 'LINK_ONLY' });
    await svc.evaluate('idea1', false);
    const data = prisma.idea.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('discoverabilityTier');
    expect(Number(data.qualityScore)).toBe(0.9);
  });

  it('404s a missing idea', async () => {
    const { svc, prisma } = setup({ score: 1 });
    prisma.idea.findUnique.mockResolvedValue(null);
    await expect(svc.evaluate('ghost', true)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('latestReport 404s when none exists', async () => {
    const { svc, prisma } = setup({ score: 1 });
    prisma.ideaQualityReport.findFirst.mockResolvedValue(null);
    await expect(svc.latestReport('idea1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
