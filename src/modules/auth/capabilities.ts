import {
  fundsEligibilityReasons,
  isFundsEligible,
  isIdentityVerified,
} from '../kyc/kyc-gates';

/**
 * What the signed-in account may do, as the API actually enforces it today.
 *
 * The web treats this as presentation only: every route still authorises on the
 * server. A capability is added here only after the corresponding route gates on
 * the same condition, so the flag can never promise more than the API allows.
 */

export type AccountRole = 'USER' | 'ADMIN';

export interface CapabilityInput {
  role: AccountRole;
  bannedAt: Date | null;
  kycStatus: string;
  amlStatus: string;
  displayName: string | null;
  username: string | null;
}

export interface AccountCapabilities {
  role: AccountRole;
  accountActive: boolean;
  requiresOnboarding: boolean;
  verification: {
    identityVerified: boolean;
    fundsEligible: boolean;
    blockers: string[];
  };
  capabilities: {
    createIdeas: boolean;
    supportIdeas: boolean;
    prePledge: boolean;
    purchaseBoosts: boolean;
    submitCampaigns: boolean;
    reviewCampaigns: boolean;
    moderateContent: boolean;
    managePlatform: boolean;
  };
  asOf: string;
}

export function buildAccountCapabilities(
  input: CapabilityInput,
  now: Date,
): AccountCapabilities {
  const verification = {
    kycStatus: input.kycStatus,
    amlStatus: input.amlStatus,
  };
  const identityVerified = isIdentityVerified(verification);
  const fundsEligible = isFundsEligible(verification);
  const isAdmin = input.role === 'ADMIN';

  return {
    role: input.role,
    accountActive: input.bannedAt === null,
    requiresOnboarding: !input.displayName || !input.username,
    verification: {
      identityVerified,
      fundsEligible,
      blockers: fundsEligibilityReasons(verification),
    },
    capabilities: {
      // Idea creation, support, pre-pledges and boost purchases are authenticated but
      // not eligibility-gated. `purchaseBoosts` mirrors that until the fee path gains a
      // KYC/AML gate; it is a visibility purchase, not a payout.
      createIdeas: true,
      supportIdeas: true,
      prePledge: true,
      purchaseBoosts: true,
      // Campaign submission runs `evaluateCampaignReviewGates`, whose creator bar is
      // funds-eligibility. KYB and per-campaign gates are evaluated at submit time and
      // are intentionally not folded into this account-level flag.
      submitCampaigns: fundsEligible,
      // Admin-guarded surfaces.
      reviewCampaigns: isAdmin,
      moderateContent: isAdmin,
      managePlatform: isAdmin,
    },
    asOf: now.toISOString(),
  };
}
