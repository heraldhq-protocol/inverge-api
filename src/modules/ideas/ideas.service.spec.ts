import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { IdeasService } from './ideas.service';

// tx handed to $transaction callbacks
function txMock() {
  return {
    ideaSignal: { upsert: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({}) },
    ideaFeedback: { upsert: jest.fn().mockResolvedValue({}) },
  };
}

function prismaMock(idea: any = null) {
  const tx = txMock();
  const prisma: any = {
    _tx: tx,
    idea: {
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'new-id', ...data })),
      update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'idea1', ...data })),
      findUnique: jest.fn().mockResolvedValue(idea),
    },
    $transaction: jest.fn(async (cb: any) => cb(tx)),
  };
  return prisma;
}

function metricsMock() {
  return {
    recompute: jest.fn().mockResolvedValue({ recomputed: true }),
    normalizeToUsd: jest.fn().mockResolvedValue(100),
  } as any;
}

const OWNED = { id: 'idea1', creatorId: 'u1', status: 'DRAFT' };

describe('IdeasService.create', () => {
  it('creates a DRAFT with the creator + optional pre-pledge target', async () => {
    const prisma = prismaMock();
    const svc = new IdeasService(prisma, metricsMock());
    await svc.create('u1', {
      title: 'My Idea', problem: 'p', solution: 's', roadmap: 'r', askAmount: 1000, creatorPrePledgeTarget: 800,
    } as any);
    const data = prisma.idea.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ creatorId: 'u1', status: 'DRAFT', askAmount: 1000, creatorPrePledgeTarget: 800 });
    expect(data.slug).toContain('my-idea');
  });

  it('defaults the pre-pledge target to null when omitted', async () => {
    const prisma = prismaMock();
    const svc = new IdeasService(prisma, metricsMock());
    await svc.create('u1', { title: 'X', problem: 'p', solution: 's', roadmap: 'r', askAmount: 10 } as any);
    expect(prisma.idea.create.mock.calls[0][0].data.creatorPrePledgeTarget).toBeNull();
  });
});

describe('IdeasService.update — draft + ownership guards', () => {
  it('updates a DRAFT owned by the caller', async () => {
    const prisma = prismaMock({ ...OWNED });
    const svc = new IdeasService(prisma, metricsMock());
    await svc.update('u1', 'idea1', { title: 'New' } as any);
    expect(prisma.idea.update).toHaveBeenCalled();
  });

  it('rejects editing a non-draft idea', async () => {
    const prisma = prismaMock({ ...OWNED, status: 'VALIDATING' });
    const svc = new IdeasService(prisma, metricsMock());
    await expect(svc.update('u1', 'idea1', { title: 'X' } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-owner (FR ownership)', async () => {
    const prisma = prismaMock({ ...OWNED, creatorId: 'someone-else' });
    const svc = new IdeasService(prisma, metricsMock());
    await expect(svc.update('u1', 'idea1', { title: 'X' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404s a missing idea', async () => {
    const prisma = prismaMock(null);
    const svc = new IdeasService(prisma, metricsMock());
    await expect(svc.update('u1', 'ghost', {} as any)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('IdeasService.publish', () => {
  it('moves DRAFT → VALIDATING and stamps validatingSince (FR-204a)', async () => {
    const prisma = prismaMock({ ...OWNED });
    const svc = new IdeasService(prisma, metricsMock());
    await svc.publish('u1', 'idea1');
    const data = prisma.idea.update.mock.calls[0][0].data;
    expect(data.status).toBe('VALIDATING');
    expect(data.validatingSince).toBeInstanceOf(Date);
  });

  it('rejects publishing a non-draft idea', async () => {
    const prisma = prismaMock({ ...OWNED, status: 'VALIDATING' });
    const svc = new IdeasService(prisma, metricsMock());
    await expect(svc.publish('u1', 'idea1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('IdeasService — signals recompute through MetricsService (FR-206a boundary)', () => {
  it('support upserts a SUPPORT signal then recomputes', async () => {
    const prisma = prismaMock({ id: 'idea1', status: 'VALIDATING' });
    const metrics = metricsMock();
    const svc = new IdeasService(prisma, metrics);
    await svc.support('u2', 'idea1');
    expect(prisma._tx.ideaSignal.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ type: 'SUPPORT' }) }),
    );
    expect(metrics.recompute).toHaveBeenCalledWith(prisma._tx, 'idea1');
  });

  it('unsupport deletes the SUPPORT signal then recomputes', async () => {
    const prisma = prismaMock({ id: 'idea1', status: 'VALIDATING' });
    const metrics = metricsMock();
    const svc = new IdeasService(prisma, metrics);
    await svc.unsupport('u2', 'idea1');
    expect(prisma._tx.ideaSignal.deleteMany).toHaveBeenCalledWith({
      where: { ideaId: 'idea1', userId: 'u2', type: 'SUPPORT' },
    });
    expect(metrics.recompute).toHaveBeenCalled();
  });

  it('pre-pledge normalizes to USD (default) and stores amount/currency/amountUsd', async () => {
    const prisma = prismaMock({ id: 'idea1', status: 'VALIDATING' });
    const metrics = metricsMock();
    const svc = new IdeasService(prisma, metrics);
    await svc.prePledge('u2', 'idea1', { amount: 500 } as any);
    expect(metrics.normalizeToUsd).toHaveBeenCalledWith(500, 'USD');
    const call = prisma._tx.ideaSignal.upsert.mock.calls[0][0];
    expect(call.create).toMatchObject({ type: 'PRE_PLEDGE', amount: 500, currency: 'USD', amountUsd: 100 });
    expect(metrics.recompute).toHaveBeenCalled();
  });

  it('pre-pledge passes an explicit NGN currency to normalization', async () => {
    const prisma = prismaMock({ id: 'idea1', status: 'VALIDATING' });
    const metrics = metricsMock();
    const svc = new IdeasService(prisma, metrics);
    await svc.prePledge('u2', 'idea1', { amount: 160000, currency: 'NGN' } as any);
    expect(metrics.normalizeToUsd).toHaveBeenCalledWith(160000, 'NGN');
  });

  it('withdraw deletes the PRE_PLEDGE signal then recomputes (FR-211)', async () => {
    const prisma = prismaMock({ id: 'idea1', status: 'VALIDATING' });
    const metrics = metricsMock();
    const svc = new IdeasService(prisma, metrics);
    await svc.withdrawPrePledge('u2', 'idea1');
    expect(prisma._tx.ideaSignal.deleteMany).toHaveBeenCalledWith({
      where: { ideaId: 'idea1', userId: 'u2', type: 'PRE_PLEDGE' },
    });
    expect(metrics.recompute).toHaveBeenCalled();
  });

  it('feedback upserts one-per-user rating then recomputes', async () => {
    const prisma = prismaMock({ id: 'idea1', status: 'VALIDATING' });
    const metrics = metricsMock();
    const svc = new IdeasService(prisma, metrics);
    await svc.feedback('u2', 'idea1', { rating: 4, body: 'nice' } as any);
    expect(prisma._tx.ideaFeedback.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ideaId_userId: { ideaId: 'idea1', userId: 'u2' } },
        create: expect.objectContaining({ rating: 4, body: 'nice' }),
      }),
    );
    expect(metrics.recompute).toHaveBeenCalled();
  });

  it('404s a signal against a missing idea (never opens a transaction)', async () => {
    const prisma = prismaMock(null); // assertSignalable finds nothing
    const metrics = metricsMock();
    const svc = new IdeasService(prisma, metrics);
    await expect(svc.support('u2', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(metrics.recompute).not.toHaveBeenCalled();
  });

  it('rejects signals on a non-published idea (DRAFT/CONVERTED cannot be pumped)', async () => {
    for (const status of ['DRAFT', 'CONVERTED', 'ARCHIVED']) {
      const prisma = prismaMock({ id: 'idea1', status });
      const metrics = metricsMock();
      const svc = new IdeasService(prisma, metrics);
      await expect(svc.prePledge('u2', 'idea1', { amount: 100 } as any)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(metrics.recompute).not.toHaveBeenCalled();
    }
  });
});
