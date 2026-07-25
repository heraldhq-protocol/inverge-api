import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BoostsService } from './boosts.service';

function paramsMock(overrides: Record<string, number> = {}) {
  const store: Record<string, number> = {
    'boost.basic.priceUSD': 5,
    'boost.featured.priceUSD': 20,
    'boost.basic.durationDays': 7,
    'boost.featured.durationDays': 30,
    ...overrides,
  };
  return { getNumber: jest.fn(async (k: string, fb = 0) => (k in store ? store[k] : fb)) } as any;
}

describe('BoostsService.purchase — flat-fee rail, metrics untouched', () => {
  function setup() {
    const prisma = {
      idea: { findUnique: jest.fn().mockResolvedValue({ id: 'idea1', discoverabilityTier: 'DISCOVERABLE' }), update: jest.fn() },
      ideaBoost: { create: jest.fn() },
    } as any;
    const flatFee = {
      createCharge: jest.fn().mockResolvedValue({ processorRef: 'ref_1', redirectUrl: 'https://pay/ref_1' }),
    } as any;
    const svc = new BoostsService(prisma, flatFee, paramsMock());
    return { svc, prisma, flatFee };
  }

  it('charges the FEATURED price and passes ideaId+tier as metadata', async () => {
    const { svc, flatFee } = setup();
    const res = await svc.purchase('user1', 'idea1', { tier: 'FEATURED' } as any);
    expect(flatFee.createCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user1',
        purpose: 'BOOST',
        amount: 20,
        currency: 'USD',
        metadata: { ideaId: 'idea1', tier: 'FEATURED' },
      }),
    );
    expect(res).toEqual({ redirectUrl: 'https://pay/ref_1', processorRef: 'ref_1' });
  });

  it('charges the BASIC price for the basic tier', async () => {
    const { svc, flatFee } = setup();
    await svc.purchase('user1', 'idea1', { tier: 'BASIC' } as any);
    expect(flatFee.createCharge).toHaveBeenCalledWith(expect.objectContaining({ amount: 5, currency: 'USD' }));
  });

  it('never touches the FR-203 validation metrics on purchase (FR-206a)', async () => {
    const { svc, prisma } = setup();
    await svc.purchase('user1', 'idea1', { tier: 'BASIC' } as any);
    expect(prisma.idea.update).not.toHaveBeenCalled();
  });

  it('404s an unknown idea', async () => {
    const { svc, prisma } = setup();
    prisma.idea.findUnique.mockResolvedValue(null);
    await expect(svc.purchase('user1', 'ghost', { tier: 'BASIC' } as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects boosting a LINK_ONLY idea below the quality floor (FR-274)', async () => {
    const { svc, prisma, flatFee } = setup();
    prisma.idea.findUnique.mockResolvedValue({ id: 'idea1', discoverabilityTier: 'LINK_ONLY' });
    await expect(svc.purchase('user1', 'idea1', { tier: 'BASIC' } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(flatFee.createCharge).not.toHaveBeenCalled(); // paid visibility can't launder low-effort pages
  });
});

describe('BoostsService.onFlatFeeSucceeded — activation writes ONLY IdeaBoost (FR-206a)', () => {
  function setup() {
    const prisma = {
      idea: { update: jest.fn(), findUnique: jest.fn() },
      ideaBoost: { create: jest.fn().mockResolvedValue({}) },
    } as any;
    const svc = new BoostsService(prisma, {} as any, paramsMock());
    return { svc, prisma };
  }

  it('creates the IdeaBoost row and never writes idea metrics', async () => {
    const { svc, prisma } = setup();
    await svc.onFlatFeeSucceeded({
      chargeId: 'c1',
      userId: 'user1',
      purpose: 'BOOST',
      metadata: { ideaId: 'idea1', tier: 'FEATURED' },
    });
    expect(prisma.ideaBoost.create).toHaveBeenCalledTimes(1);
    const data = prisma.ideaBoost.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ ideaId: 'idea1', tier: 'FEATURED', flatFeeChargeId: 'c1', purchasedByUserId: 'user1' });
    expect(data.endsAt.getTime()).toBeGreaterThan(data.startsAt.getTime()); // 30-day window
    // The critical invariant: paid placement cannot move behavioural metrics.
    expect(prisma.idea.update).not.toHaveBeenCalled();
  });

  it('ignores non-BOOST charges (e.g. application fee) entirely', async () => {
    const { svc, prisma } = setup();
    await svc.onFlatFeeSucceeded({ chargeId: 'c2', userId: 'u', purpose: 'APPLICATION_FEE', metadata: {} });
    expect(prisma.ideaBoost.create).not.toHaveBeenCalled();
  });

  it('skips activation when BOOST metadata is missing', async () => {
    const { svc, prisma } = setup();
    await svc.onFlatFeeSucceeded({ chargeId: 'c3', userId: 'u', purpose: 'BOOST', metadata: {} });
    expect(prisma.ideaBoost.create).not.toHaveBeenCalled();
  });
});
