import { ForbiddenException } from '@nestjs/common';
import { KycService } from './kyc.service';

// KycService is now a compatibility facade over the verification domain. These tests pin
// the forwarding contract and the one piece it still owns: standalone AML screening.
function setup(opts: { business?: any; user?: any } = {}) {
  const user = opts.user ?? {
    id: 'u1',
    email: 'a@b.com',
    kycStatus: 'PENDING',
    amlStatus: 'NOT_SCREENED',
  };

  const provider = {
    screenAml: jest.fn().mockResolvedValue({
      datasets: [],
      providerRequestId: 'req1',
      status: 'CLEAR',
      topRiskScore: 0,
      totalHits: 0,
    }),
  } as any;

  const prisma = {
    amlScreening: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    businessProfile: {
      findUnique: jest.fn().mockResolvedValue(opts.business ?? null),
      findUniqueOrThrow: jest.fn().mockResolvedValue(opts.business ?? { id: 'biz1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    user: { update: jest.fn().mockResolvedValue(user) },
    $transaction: jest.fn((arr: Promise<unknown>[]) => Promise.all(arr)),
  } as any;

  const verification = {
    assertFundsEligible: jest.fn().mockResolvedValue(undefined),
    backerThresholdUsd: jest.fn().mockResolvedValue(200),
    businessStatus: jest.fn().mockResolvedValue({ registered: false }),
    campaignGate: jest.fn().mockResolvedValue({ eligible: true, blockers: [] }),
    eligibility: jest.fn().mockResolvedValue({ eligible: true }),
    handleWebhook: jest.fn().mockResolvedValue({ accepted: true }),
    legacyStatus: jest.fn().mockResolvedValue({ kycStatus: 'PENDING' }),
    startBusinessSession: jest.fn().mockResolvedValue({ purpose: 'BUSINESS_VERIFICATION' }),
    startSession: jest.fn().mockResolvedValue({ caseId: 'c1' }),
    state: jest.fn().mockResolvedValue({ blockers: [], fundsCleared: false }),
  } as any;

  return {
    prisma,
    provider,
    svc: new KycService(provider, prisma, verification),
    verification,
  };
}

describe('KycService delegation', () => {
  it('forwards status, session, webhook and eligibility to the verification domain', async () => {
    const { svc, verification } = setup();
    await svc.status('u1');
    await svc.startSession('u1', 'CAMPAIGN_CREATOR');
    await svc.handleWebhook('{}', {});
    await svc.eligibility('u1', 'IDEA_VALIDATION');

    expect(verification.legacyStatus).toHaveBeenCalledWith('u1');
    expect(verification.startSession).toHaveBeenCalledWith('u1', {
      purpose: 'CAMPAIGN_CREATOR',
    });
    expect(verification.handleWebhook).toHaveBeenCalledWith('{}', {});
    expect(verification.eligibility).toHaveBeenCalledWith('u1', 'IDEA_VALIDATION');
  });

  it('delegates the funds gate rather than re-deriving it', async () => {
    const { svc, verification } = setup();
    verification.assertFundsEligible.mockRejectedValueOnce(
      new ForbiddenException({ code: 'VERIFICATION_REQUIRED' }),
    );
    await expect(svc.assertFundsEligible('u1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(verification.assertFundsEligible).toHaveBeenCalledWith('u1');
  });

  it('keeps the FR-104 threshold check for legacy callers and does not verify below it', async () => {
    const { svc, verification } = setup();
    await expect(svc.assertBackerFundingAllowed('u1', 0, 100)).resolves.toBeUndefined();
    expect(verification.assertFundsEligible).not.toHaveBeenCalled();

    await expect(svc.assertBackerFundingAllowed('u1', 150, 100)).resolves.toBeUndefined();
    expect(verification.assertFundsEligible).toHaveBeenCalledWith('u1');
  });

  it('rejects a business gate with the domain code', async () => {
    const { svc, verification } = setup();
    verification.campaignGate.mockResolvedValueOnce({
      blockers: ['Business verification (KYB) is required'],
      code: 'VERIFICATION_REQUIRED',
      eligible: false,
    });
    await expect(svc.assertBusinessFundsEligible('u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('KycService standalone AML', () => {
  it('records aggregates only and never the provider raw response', async () => {
    const { svc, provider, prisma } = setup();
    provider.screenAml.mockResolvedValueOnce({
      datasets: ['PEP'],
      providerRequestId: 'req1',
      status: 'IN_REVIEW',
      topRiskScore: 85,
      totalHits: 2,
    });
    const result = await svc.screenAml('u1', { fullName: 'John Smith' });

    expect(result).toEqual({
      datasets: ['PEP'],
      status: 'IN_REVIEW',
      topRiskScore: 85,
      totalHits: 2,
    });
    expect(prisma.amlScreening.create.mock.calls[0][0].data).toMatchObject({
      datasets: ['PEP'],
      source: 'STANDALONE',
      status: 'IN_REVIEW',
      totalHits: 2,
      userId: 'u1',
    });
    expect(prisma.amlScreening.create.mock.calls[0][0].data.raw).toEqual({
      datasets: ['PEP'],
      topRiskScore: 85,
      totalHits: 2,
    });
  });

  it('screens a business as a company and attaches the record to the business', async () => {
    const { svc, provider, prisma } = setup({ business: { id: 'biz1' } });
    provider.screenAml.mockResolvedValueOnce({
      datasets: ['Sanctions'],
      providerRequestId: null,
      status: 'FLAGGED',
      topRiskScore: 100,
      totalHits: 1,
    });
    const result = await svc.screenBusinessAml('u1', { fullName: 'Acme Ltd' });
    expect(provider.screenAml).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'company' }),
    );
    expect(result.topRiskScore).toBe(100);
    expect(prisma.amlScreening.create.mock.calls[0][0].data).toMatchObject({
      businessId: 'biz1',
      status: 'FLAGGED',
    });
  });
});
