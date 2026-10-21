import { businessFundsReasons } from '../kyc/kyb-gates';
import { fundsEligibilityReasons } from '../kyc/kyc-gates';

// FR-103 + FR-311: the two gates that must hold before a campaign may enter the
// curation queue. Pure so the submit path, the approval re-check, the review detail
// surface and tests all read the same facts. A gate never simulates a provider: it
// reports what the persisted statuses and the application-fee record actually say.

export interface CampaignCreatorGateFacts {
  kycStatus: string;
  amlStatus: string;
}

export interface CampaignBusinessGateFacts {
  kybStatus: string;
  amlStatus: string;
}

export interface ApplicationFeeGateFacts {
  id: string;
  userId: string;
  purpose: string;
  status: string;
  metadata?: unknown;
}

export interface CampaignReviewGateInput {
  campaignId: string;
  creatorId: string;
  applicationFeeChargeId: string | null;
  creator: CampaignCreatorGateFacts;
  business: CampaignBusinessGateFacts | null;
  applicationFee: ApplicationFeeGateFacts | null;
}

export interface CampaignReviewGateCheck {
  key: 'identity' | 'application_fee';
  label: string;
  satisfied: boolean;
  detail: string;
}

export interface CampaignReviewGateResult {
  eligible: boolean;
  blockers: string[];
  checks: CampaignReviewGateCheck[];
}

function boundCampaignId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).campaignId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function evaluateIdentity(input: CampaignReviewGateInput): {
  satisfied: boolean;
  detail: string;
  blockers: string[];
} {
  const personalReasons = fundsEligibilityReasons(input.creator);
  const businessReasons = input.business
    ? businessFundsReasons(input.business)
    : [];
  const personalOk = personalReasons.length === 0;
  const businessOk = input.business !== null && businessReasons.length === 0;

  if (personalOk) {
    return {
      satisfied: true,
      detail: 'Creator identity is verified and AML screening is clear',
      blockers: [],
    };
  }
  if (businessOk) {
    return {
      satisfied: true,
      detail: 'Business is verified (KYB) and its AML screening is clear',
      blockers: [],
    };
  }

  const blockerLines = personalReasons.map((r) => `Creator: ${r}`);
  if (input.business) {
    blockerLines.push(...businessReasons.map((r) => `Business: ${r}`));
  }

  return {
    satisfied: false,
    detail: input.business
      ? `Creator: ${personalReasons.join('; ')}. Business: ${businessReasons.join('; ')}`
      : personalReasons.join('; '),
    blockers: blockerLines,
  };
}

function evaluateApplicationFee(input: CampaignReviewGateInput): {
  satisfied: boolean;
  detail: string;
  blocker: string | null;
} {
  const charge = input.applicationFee;
  const chargeId = input.applicationFeeChargeId;

  if (!chargeId) {
    return {
      satisfied: false,
      detail: 'No application-fee payment is linked to this campaign',
      blocker: 'Application fee (FR-311) has not been paid',
    };
  }
  if (!charge) {
    return {
      satisfied: false,
      detail: 'The linked application-fee record was not found',
      blocker: 'Application fee (FR-311) payment record was not found',
    };
  }
  if (charge.userId !== input.creatorId) {
    return {
      satisfied: false,
      detail: 'The application fee was paid by a different account',
      blocker: 'Application fee (FR-311) was not paid by the campaign creator',
    };
  }
  if (charge.purpose !== 'APPLICATION_FEE') {
    return {
      satisfied: false,
      detail: 'The linked charge is not an application fee',
      blocker: 'Linked charge is not an application fee (FR-311)',
    };
  }
  if (charge.status !== 'SUCCEEDED') {
    return {
      satisfied: false,
      detail: `The application fee is ${charge.status.toLowerCase()}`,
      blocker: `Application fee (FR-311) is ${charge.status.toLowerCase()}`,
    };
  }

  const boundCampaign = boundCampaignId(charge.metadata);
  if (boundCampaign && boundCampaign !== input.campaignId) {
    return {
      satisfied: false,
      detail: 'The application fee belongs to a different campaign',
      blocker: 'Application fee (FR-311) belongs to another campaign',
    };
  }

  return {
    satisfied: true,
    detail: 'A successful application fee is linked to this campaign',
    blocker: null,
  };
}

export function evaluateCampaignReviewGates(
  input: CampaignReviewGateInput,
): CampaignReviewGateResult {
  const identity = evaluateIdentity(input);
  const fee = evaluateApplicationFee(input);

  const checks: CampaignReviewGateCheck[] = [
    {
      key: 'identity',
      label: 'Identity and AML (FR-103)',
      satisfied: identity.satisfied,
      detail: identity.detail,
    },
    {
      key: 'application_fee',
      label: 'Application fee (FR-311)',
      satisfied: fee.satisfied,
      detail: fee.detail,
    },
  ];

  const blockers = [
    ...identity.blockers,
    ...(fee.blocker ? [fee.blocker] : []),
  ];

  return {
    eligible: blockers.length === 0,
    blockers,
    checks,
  };
}
