import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationFeeService } from './application-fee.service';

const campaign = (overrides: Record<string, unknown> = {}) => ({
  applicationFeeChargeId: null,
  creator: { email: 'creator@example.test' },
  creatorId: 'user1',
  id: 'cmp1',
  reviewStatus: 'NOT_SUBMITTED',
  status: 'DRAFT',
  ...overrides,
});

const charge = (overrides: Record<string, unknown> = {}) => ({
  amount: 10000,
  currency: 'NGN',
  id: 'fee1',
  redirectUrl: 'https://pay.example/fee1',
  status: 'PENDING',
  ...overrides,
});

function setup(options: {
  campaign?: Record<string, unknown> | null;
  charge?: Record<string, unknown> | null;
  gate?: Record<string, unknown>;
  price?: number;
} = {}) {
  const prisma = {
    campaign: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.campaign === undefined ? campaign() : options.campaign,
        ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    flatFeeCharge: {
      findUnique: jest.fn().mockResolvedValue(options.charge ?? null),
    },
  } as any;
  const flatFee = {
    createCharge: jest.fn().mockResolvedValue({
      chargeId: 'fee-new',
      processorRef: 'ref-new',
      redirectUrl: 'https://pay.example/fee-new',
    }),
    voidCharge: jest.fn().mockResolvedValue(undefined),
  } as any;
  const params = {
    getNumber: jest.fn(async (_key: string, fallback: number) =>
      options.price ?? fallback,
    ),
  } as any;
  const verification = {
    campaignGate: jest.fn().mockResolvedValue(
      options.gate ?? { blockers: [], code: null, eligible: true },
    ),
  } as any;
  const cache = { bumpEventually: jest.fn() } as any;
  const svc = new ApplicationFeeService(
    prisma,
    flatFee,
    params,
    verification,
    cache,
  );
  return { cache, flatFee, params, prisma, svc, verification };
}

describe('ApplicationFeeService.getOrCreate', () => {
  it('creates a campaign-bound charge at the configured price and links it', async () => {
    const { cache, flatFee, prisma, svc } = setup();

    const result = await svc.getOrCreate('user1', 'cmp1');

    expect(flatFee.createCharge).toHaveBeenCalledWith({
      amount: 10000,
      currency: 'NGN',
      email: 'creator@example.test',
      metadata: { campaignId: 'cmp1' },
      purpose: 'APPLICATION_FEE',
      userId: 'user1',
    });
    expect(prisma.campaign.updateMany).toHaveBeenCalledWith({
      where: {
        applicationFeeChargeId: null,
        creatorId: 'user1',
        id: 'cmp1',
      },
      data: { applicationFeeChargeId: 'fee-new' },
    });
    expect(result).toEqual({
      alreadyPaid: false,
      amount: 10000,
      chargeId: 'fee-new',
      currency: 'NGN',
      redirectUrl: 'https://pay.example/fee-new',
      status: 'PENDING',
    });
    expect(cache.bumpEventually).toHaveBeenCalledWith('campaigns');
  });

  it('returns the existing pending charge without creating a second one', async () => {
    const { flatFee, svc } = setup({
      campaign: campaign({ applicationFeeChargeId: 'fee1' }),
      charge: charge(),
    });

    const result = await svc.getOrCreate('user1', 'cmp1');

    expect(flatFee.createCharge).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      alreadyPaid: false,
      chargeId: 'fee1',
      redirectUrl: 'https://pay.example/fee1',
      status: 'PENDING',
    });
  });

  it('returns a successful charge as already paid without re-checking verification', async () => {
    const { flatFee, svc, verification } = setup({
      campaign: campaign({ applicationFeeChargeId: 'fee1' }),
      charge: charge({ status: 'SUCCEEDED' }),
    });

    const result = await svc.getOrCreate('user1', 'cmp1');

    expect(flatFee.createCharge).not.toHaveBeenCalled();
    expect(verification.campaignGate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ alreadyPaid: true, status: 'SUCCEEDED' });
  });

  it('replaces a failed charge and links the replacement', async () => {
    const { flatFee, prisma, svc } = setup({
      campaign: campaign({ applicationFeeChargeId: 'fee1' }),
      charge: charge({ status: 'FAILED' }),
    });

    const result = await svc.getOrCreate('user1', 'cmp1');

    expect(flatFee.createCharge).toHaveBeenCalledTimes(1);
    expect(prisma.campaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ applicationFeeChargeId: 'fee1' }),
      }),
    );
    expect(result.chargeId).toBe('fee-new');
  });

  it('refuses to take money from a creator the verification gate rejects', async () => {
    const { flatFee, svc } = setup({
      gate: {
        blockers: ['Creator: identity verification is pending'],
        code: 'VERIFICATION_REQUIRED',
        eligible: false,
      },
    });

    await expect(svc.getOrCreate('user1', 'cmp1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(flatFee.createCharge).not.toHaveBeenCalled();
  });

  it('refuses to resume a pending payment when verification is no longer clear', async () => {
    const { flatFee, svc } = setup({
      campaign: campaign({ applicationFeeChargeId: 'fee1' }),
      charge: charge(),
      gate: {
        blockers: ['Creator: identity verification is pending'],
        code: 'VERIFICATION_REQUIRED',
        eligible: false,
      },
    });

    await expect(svc.getOrCreate('user1', 'cmp1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(flatFee.createCharge).not.toHaveBeenCalled();
  });

  it('returns the winner of a concurrent link race and retires its own charge', async () => {
    const { flatFee, prisma, svc } = setup();
    prisma.campaign.updateMany.mockResolvedValue({ count: 0 });
    prisma.campaign.findUnique
      .mockResolvedValueOnce(campaign())
      .mockResolvedValueOnce({ applicationFeeChargeId: 'winner' });
    prisma.flatFeeCharge.findUnique.mockResolvedValue(
      charge({ id: 'winner', redirectUrl: 'https://pay.example/winner' }),
    );

    const result = await svc.getOrCreate('user1', 'cmp1');

    expect(flatFee.voidCharge).toHaveBeenCalledWith('fee-new');
    expect(result).toMatchObject({
      chargeId: 'winner',
      redirectUrl: 'https://pay.example/winner',
    });
  });

  it('rejects a campaign owned by another account', async () => {
    const { svc } = setup({ campaign: campaign({ creatorId: 'someone-else' }) });
    await expect(svc.getOrCreate('user1', 'cmp1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects a campaign that is no longer a draft', async () => {
    const { svc } = setup({
      campaign: campaign({ reviewStatus: 'IN_REVIEW', status: 'IN_REVIEW' }),
    });
    await expect(svc.getOrCreate('user1', 'cmp1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('404s an unknown campaign', async () => {
    const { svc } = setup({ campaign: null });
    await expect(svc.getOrCreate('user1', 'cmp1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses to charge a misconfigured price', async () => {
    const { flatFee, svc } = setup({ price: 0 });
    await expect(svc.getOrCreate('user1', 'cmp1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(flatFee.createCharge).not.toHaveBeenCalled();
  });

  it('does not pretend a pending charge without a redirect URL is resumable', async () => {
    const { svc } = setup({
      campaign: campaign({ applicationFeeChargeId: 'fee1' }),
      charge: charge({ redirectUrl: null }),
    });
    await expect(svc.getOrCreate('user1', 'cmp1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
