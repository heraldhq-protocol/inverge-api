import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { KycService } from './kyc.service';

function setup(
  opts: {
    user?: any;
    webhookEvt?: any;
    decision?: any;
    threshold?: number;
    business?: any; // when set, the webhook resolves this business by kybProviderRef
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
    businessProfile: {
      findFirst: jest.fn().mockResolvedValue(opts.business ?? null),
      findUnique: jest.fn().mockResolvedValue(opts.business ?? null),
      findUniqueOrThrow: jest.fn().mockResolvedValue(
        opts.business ?? { id: 'biz1', userId: 'u1', kybStatus: 'PENDING', amlStatus: 'NOT_SCREENED' },
      ),
      upsert: jest.fn().mockResolvedValue(
        opts.business ?? { id: 'biz1', userId: 'u1', kybStatus: 'NOT_REQUIRED', amlStatus: 'NOT_SCREENED' },
      ),
      update: jest.fn().mockResolvedValue({}),
    },
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

describe('KycService business (KYB)', () => {
  const biz = (over: any = {}) => ({
    id: 'biz1',
    userId: 'u1',
    kybStatus: 'PENDING',
    amlStatus: 'NOT_SCREENED',
    kybProviderRef: 'sess1',
    ...over,
  });

  it('routes a webhook whose ref matches a business to the BusinessProfile', async () => {
    const { svc, prisma } = setup({
      business: biz(),
      decision: {
        providerRef: 'sess1',
        status: 'VERIFIED',
        aml: 'CLEAR',
        amlSummary: { totalHits: 0, topRiskScore: 0, datasets: [] },
        raw: {},
      },
    });
    const res = await svc.handleWebhook('{}', {});
    expect(res).toMatchObject({ entity: 'business', kyb: 'VERIFIED', aml: 'CLEAR' });
    // Business status updated, not the user's KYC.
    const bizUpdate = prisma.businessProfile.update.mock.calls.find((c: any[]) => c[0].data.kybStatus);
    expect(bizUpdate[0].data.kybStatus).toBe('VERIFIED');
    // AML record attached to the business.
    expect(prisma.amlScreening.create.mock.calls[0][0].data).toMatchObject({
      businessId: 'biz1',
      source: 'KYC_SESSION',
      status: 'CLEAR',
    });
    // The user KYC path was not touched.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('businessEligibility is true only when KYB VERIFIED + AML CLEAR', async () => {
    const eligible = setup({ business: biz({ kybStatus: 'VERIFIED', amlStatus: 'CLEAR' }) });
    expect((await eligible.svc.businessEligibility('u1')).eligible).toBe(true);

    const pending = setup({ business: biz({ kybStatus: 'VERIFIED', amlStatus: 'NOT_SCREENED' }) });
    const e = await pending.svc.businessEligibility('u1');
    expect(e.eligible).toBe(false);
    expect(e.reasons).toContain('AML screening is required');
  });

  it('businessEligibility reports unregistered when no business exists', async () => {
    const { svc } = setup(); // business defaults to null
    const e = await svc.businessEligibility('u1');
    expect(e).toMatchObject({ registered: false, eligible: false });
  });

  it('assertBusinessFundsEligible throws unless KYB+AML clear', async () => {
    const notCleared = setup({ business: biz({ kybStatus: 'VERIFIED', amlStatus: 'FLAGGED' }) });
    await expect(notCleared.svc.assertBusinessFundsEligible('u1')).rejects.toBeInstanceOf(ForbiddenException);

    const cleared = setup({ business: biz({ kybStatus: 'VERIFIED', amlStatus: 'CLEAR' }) });
    await expect(cleared.svc.assertBusinessFundsEligible('u1')).resolves.toBeUndefined();
  });

  it('startBusinessSession upserts the business and starts a KYB session', async () => {
    const { svc, provider, prisma } = setup();
    const res = await svc.startBusinessSession('u1', { legalName: 'Acme NG Ltd', country: 'NG' });
    expect(prisma.businessProfile.upsert).toHaveBeenCalled();
    expect(provider.startVerification).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'BUSINESS_VERIFICATION', userId: 'u1' }),
    );
    expect(res.purpose).toBe('BUSINESS_VERIFICATION');
  });

  it('screenBusinessAml screens as a company and stores a business record', async () => {
    const { svc, provider, prisma } = setup({ business: biz() });
    provider.screenAml.mockResolvedValue({ status: 'FLAGGED', totalHits: 1, topRiskScore: 100, datasets: ['Sanctions'], raw: {} });
    const r = await svc.screenBusinessAml('u1', { fullName: 'Acme NG Ltd' });
    expect(provider.screenAml).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'company' }));
    expect(r.status).toBe('FLAGGED');
    expect(prisma.amlScreening.create.mock.calls[0][0].data).toMatchObject({ businessId: 'biz1', source: 'STANDALONE' });
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
