import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { KycService } from './kyc.service';

function setup(
  opts: {
    user?: any;
    webhookEvt?: any;
    decision?: any;
    threshold?: number;
  } = {},
) {
  const user = opts.user ?? {
    id: 'u1',
    email: 'a@b.com',
    kycStatus: 'PENDING',
    amlStatus: 'NOT_SCREENED',
    kycProviderRef: 'sess1',
  };

  const provider = {
    startVerification: jest.fn().mockResolvedValue({
      providerRef: 'sess1',
      verificationUrl: 'https://verify/sess1',
    }),
    getDecision: jest.fn().mockResolvedValue(
      opts.decision ?? { providerRef: 'sess1', status: 'VERIFIED', aml: null, amlSummary: null, raw: {} },
    ),
    parseWebhook: jest.fn().mockReturnValue(
      opts.webhookEvt ?? { providerRef: 'sess1', vendorData: 'u1', status: 'VERIFIED', aml: null },
    ),
    screenAml: jest.fn(),
  } as any;

  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      findUniqueOrThrow: jest.fn().mockResolvedValue(user),
      findFirst: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue(user),
    },
    kycStatusEvent: { create: jest.fn().mockResolvedValue({}) },
    amlScreening: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    platformParam: { findUnique: jest.fn().mockResolvedValue({ value: opts.threshold ?? 200 }) },
    $transaction: jest.fn((arr: Promise<unknown>[]) => Promise.all(arr)),
  } as any;

  const config = { get: jest.fn().mockReturnValue('https://app/cb') } as any;

  return { svc: new KycService(provider, prisma, config), provider, prisma };
}

describe('KycService.handleWebhook', () => {
  it('trusts the authoritative getDecision over the (spoofable) webhook body', async () => {
    // Webhook claims VERIFIED, but the re-fetched decision says REJECTED — REJECTED must win.
    const { svc, prisma } = setup({
      webhookEvt: { providerRef: 'sess1', vendorData: 'u1', status: 'VERIFIED', aml: null },
      decision: { providerRef: 'sess1', status: 'REJECTED', aml: null, amlSummary: null, raw: {} },
    });
    await svc.handleWebhook('{}', {});
    const updates = prisma.user.update.mock.calls.map((c: any[]) => c[0].data);
    expect(updates.some((d: any) => d.kycStatus === 'REJECTED')).toBe(true);
    expect(updates.some((d: any) => d.kycStatus === 'VERIFIED')).toBe(false);
  });

  it('records an AML screening + sets amlStatus when the decision carries AML', async () => {
    const { svc, prisma } = setup({
      decision: {
        providerRef: 'sess1',
        status: 'VERIFIED',
        aml: 'FLAGGED',
        amlSummary: { totalHits: 1, topRiskScore: 100, datasets: ['Sanctions'] },
        raw: { hit: true },
      },
    });
    await svc.handleWebhook('{}', {});
    const amlCreate = prisma.amlScreening.create.mock.calls[0][0].data;
    expect(amlCreate).toMatchObject({
      userId: 'u1',
      source: 'KYC_SESSION',
      status: 'FLAGGED',
      totalHits: 1,
      datasets: ['Sanctions'],
    });
    const amlUpdate = prisma.user.update.mock.calls.find((c: any[]) => c[0].data.amlStatus);
    expect(amlUpdate[0].data.amlStatus).toBe('FLAGGED');
  });

  it('rejects an unverifiable webhook (parseWebhook → null)', async () => {
    const { svc, provider } = setup();
    provider.parseWebhook.mockReturnValue(null);
    await expect(svc.handleWebhook('{}', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignores a webhook for an unknown session', async () => {
    const { svc, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
    expect(await svc.handleWebhook('{}', {})).toEqual({ ignored: true });
  });

  it('still applies the KYC status when getDecision fails (falls back to the verified body)', async () => {
    const { svc, provider, prisma } = setup({
      webhookEvt: { providerRef: 'sess1', vendorData: 'u1', status: 'VERIFIED', aml: null },
    });
    provider.getDecision.mockRejectedValue(new Error('network'));
    await svc.handleWebhook('{}', {});
    const updates = prisma.user.update.mock.calls.map((c: any[]) => c[0].data);
    expect(updates.some((d: any) => d.kycStatus === 'VERIFIED')).toBe(true);
  });
});

describe('KycService eligibility + gates', () => {
  it('idea-validation is eligible on KYC alone; creator needs AML CLEAR', async () => {
    const { svc } = setup({ user: { id: 'u1', kycStatus: 'VERIFIED', amlStatus: 'NOT_SCREENED' } });
    expect((await svc.eligibility('u1', 'IDEA_VALIDATION')).eligible).toBe(true);
    expect((await svc.eligibility('u1', 'CAMPAIGN_CREATOR')).eligible).toBe(false);
  });

  it('assertFundsEligible throws for a non-cleared user', async () => {
    const { svc } = setup({ user: { id: 'u1', kycStatus: 'VERIFIED', amlStatus: 'NOT_SCREENED' } });
    await expect(svc.assertFundsEligible('u1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('assertFundsEligible passes for a cleared user', async () => {
    const { svc } = setup({ user: { id: 'u1', kycStatus: 'VERIFIED', amlStatus: 'CLEAR' } });
    await expect(svc.assertFundsEligible('u1')).resolves.toBeUndefined();
  });

  it('backer funding below the threshold needs no KYC; crossing it does (FR-104)', async () => {
    const { svc } = setup({ user: { id: 'u1', kycStatus: 'NOT_REQUIRED', amlStatus: 'NOT_SCREENED' }, threshold: 200 });
    await expect(svc.assertBackerFundingAllowed('u1', 0, 100)).resolves.toBeUndefined();
    await expect(svc.assertBackerFundingAllowed('u1', 150, 100)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('KycService.screenAml (standalone)', () => {
  it('screens and stores a STANDALONE record', async () => {
    const { svc, provider, prisma } = setup();
    provider.screenAml.mockResolvedValue({
      status: 'IN_REVIEW',
      totalHits: 2,
      topRiskScore: 85,
      datasets: ['PEP'],
      raw: {},
    });
    const r = await svc.screenAml('u1', { fullName: 'John Smith' });
    expect(r.status).toBe('IN_REVIEW');
    expect(prisma.amlScreening.create.mock.calls[0][0].data).toMatchObject({
      source: 'STANDALONE',
      status: 'IN_REVIEW',
      datasets: ['PEP'],
    });
  });
});
