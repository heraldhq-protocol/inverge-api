import type { VerificationCase } from '../../generated/prisma/client';
import type { SubjectSnapshot } from './verification.repository';
import { VerificationService } from './verification.service';

const now = new Date('2026-11-02T13:00:00Z');

function caseRow(overrides: Partial<VerificationCase> = {}): VerificationCase {
  return {
    attempt: 1,
    businessId: null,
    createdAt: now,
    decidedAt: null,
    decisionCode: null,
    expiresAt: null,
    features: [],
    id: 'case-1',
    lastErrorCode: null,
    lastErrorMessage: null,
    lastProviderSyncAt: null,
    nextReconcileAt: null,
    provider: 'DIDIT',
    providerSessionId: 'sess-1',
    providerStatus: 'Resubmitted',
    providerWorkflowId: 'wf-1',
    purpose: 'CAMPAIGN_CREATOR',
    reconcileAttempts: 0,
    requiresHumanReview: false,
    riskOutcome: 'NOT_ASSESSED',
    riskReasonCodes: [],
    status: 'ACTION_REQUIRED',
    submittedAt: null,
    type: 'INDIVIDUAL',
    updatedAt: now,
    userId: 'user-1',
    ...overrides,
  } as VerificationCase;
}

function snapshot(individualCase = caseRow()): SubjectSnapshot {
  return {
    business: null,
    businessCase: null,
    individualCase,
    user: {
      accountType: 'INDIVIDUAL',
      amlStatus: 'NOT_SCREENED',
      bannedAt: null,
      email: 'user@example.com',
      id: 'user-1',
      kycProviderRef: null,
      kycStatus: 'PENDING',
      role: 'USER',
    },
  };
}

describe('VerificationService.startSession session reuse', () => {
  const repo = {
    appendCaseEvent: jest.fn(),
    cancelActiveCases: jest.fn(),
    countAttempts: jest.fn(),
    createCase: jest.fn(),
    findCaseByProviderSession: jest.fn(),
    loadSubject: jest.fn(),
    reactivateCase: jest.fn(),
  };
  const provider = {
    getDecision: jest.fn(),
    parseWebhook: jest.fn(),
    screenAml: jest.fn(),
    startVerification: jest.fn(),
  };
  const config = {
    get: jest.fn((key: string) => {
      const values: Record<string, unknown> = {
        DIDIT_CALLBACK_URL: 'https://app.example/return',
        DIDIT_KYB_REQUIRE_KEY_PEOPLE: true,
        VERIFICATION_POLICY_VERSION: 'test',
        VERIFICATION_RECONCILE_AFTER_MINUTES: 15,
        VERIFICATION_RETRY_MAX_PER_DAY: 5,
      };
      return values[key];
    }),
  };

  const service = new VerificationService(
    repo as never,
    {} as never,
    provider as never,
    config as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    repo.loadSubject.mockResolvedValue(snapshot());
    repo.countAttempts.mockResolvedValue(1);
    provider.startVerification.mockResolvedValue({
      providerRef: 'sess-1',
      providerStatus: 'Resubmitted',
      sessionKind: 'user',
      verificationUrl: 'https://verify.didit.me/sess-1',
      workflowId: 'wf-1',
    });
  });

  it('reuses the case when Didit returns the existing resubmitted session', async () => {
    const existing = caseRow();
    repo.findCaseByProviderSession.mockResolvedValue(existing);
    repo.reactivateCase.mockResolvedValue(existing);

    const result = await service.startSession('user-1', {
      purpose: 'CAMPAIGN_CREATOR',
    });

    expect(result).toMatchObject({
      attempt: 1,
      caseId: 'case-1',
      providerRef: 'sess-1',
      resumed: true,
      verificationUrl: 'https://verify.didit.me/sess-1',
    });
    expect(repo.createCase).not.toHaveBeenCalled();
    expect(repo.cancelActiveCases).not.toHaveBeenCalled();
    expect(repo.reactivateCase).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: 'case-1',
        providerStatus: 'Resubmitted',
        state: 'ACTION_REQUIRED',
      }),
    );
  });

  it('does not let the daily attempt cap block a resumable session', async () => {
    repo.countAttempts.mockResolvedValue(99);
    repo.findCaseByProviderSession.mockResolvedValue(caseRow());
    repo.reactivateCase.mockResolvedValue(caseRow());

    await expect(
      service.startSession('user-1', { purpose: 'CAMPAIGN_CREATOR' }),
    ).resolves.toMatchObject({ resumed: true });
  });

  it('reopens a locally cancelled case when Didit still holds the session', async () => {
    repo.countAttempts.mockResolvedValue(99);
    const cancelled = caseRow({ status: 'CANCELLED' });
    repo.loadSubject.mockResolvedValue(snapshot(cancelled));
    repo.findCaseByProviderSession.mockResolvedValue(cancelled);
    repo.reactivateCase.mockResolvedValue(
      caseRow({ status: 'ACTION_REQUIRED' }),
    );

    await expect(
      service.startSession('user-1', { purpose: 'CAMPAIGN_CREATOR' }),
    ).resolves.toMatchObject({ resumed: true });
  });

  it('creates a new case when the provider returns a new session', async () => {
    repo.findCaseByProviderSession.mockResolvedValue(null);
    repo.createCase.mockResolvedValue(caseRow({ attempt: 2, id: 'case-2' }));

    const result = await service.startSession('user-1', {
      purpose: 'CAMPAIGN_CREATOR',
    });

    expect(result).toMatchObject({ caseId: 'case-2', attempt: 2 });
    expect(repo.cancelActiveCases).toHaveBeenCalledWith({
      reason: 'REPLACED_BY_NEW_SESSION',
      type: 'INDIVIDUAL',
      userId: 'user-1',
    });
    expect(repo.createCase).toHaveBeenCalled();
  });
});
