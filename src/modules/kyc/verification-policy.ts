import {
  isActiveState,
  isFundsCleared,
  isIdentityCleared,
  type RiskState,
  type VerificationState,
} from './verification-status';

// Configurable verification policy (FR-103 / FR-104). Pure: it reads facts the
// service has already loaded and returns the requirements, the user-safe blockers and
// the next action. No provider call, no database, no hidden defaults that drift
// between the campaign gate and the status screen.

export type VerificationRequirementKey =
  | 'INDIVIDUAL_IDENTITY'
  | 'INDIVIDUAL_AML'
  | 'BUSINESS_REGISTRATION'
  | 'BUSINESS_AML'
  | 'BUSINESS_KEY_PEOPLE'
  | 'REPRESENTATIVE_IDENTITY';

export interface VerificationRequirement {
  key: VerificationRequirementKey;
  label: string;
  satisfied: boolean;
  detail: string;
}

export interface CaseFacts {
  state: VerificationState;
  risk: RiskState;
  /** Provider feature codes the decision reported, e.g. ['OCR','AML','KYB_KEY_PEOPLE']. */
  features: readonly string[];
  providerStatus?: string | null;
}

export interface VerificationFacts {
  accountType: 'INDIVIDUAL' | 'BUSINESS';
  individual: CaseFacts | null;
  business: (CaseFacts & { registered: boolean }) | null;
}

export interface VerificationPolicyOptions {
  /**
   * A KYB workflow that runs KYB_KEY_PEOPLE is the only evidence Inverge accepts that
   * the business's beneficial owners were checked. When this is true, a business case
   * whose decision does not report that feature cannot be treated as complete.
   */
  requireKeyPeople: boolean;
  policyVersion: string;
}

export type VerificationNextAction =
  | 'start'
  | 'resume'
  | 'wait'
  | 'retry'
  | 'contact_support'
  | 'resolve_review'
  | 'complete_business_profile'
  | 'none';

export interface VerificationEvaluation {
  eligible: boolean;
  requirements: VerificationRequirement[];
  blockers: string[];
  nextAction: VerificationNextAction;
  policyVersion: string;
}

function individualRequirements(
  individual: CaseFacts | null,
  requireAml: boolean,
): VerificationRequirement[] {
  const identitySatisfied = individual
    ? isIdentityCleared(individual.state)
    : false;
  const amlSatisfied = individual
    ? individual.risk === 'CLEAR'
    : false;

  return [
    {
      key: 'INDIVIDUAL_IDENTITY',
      label: 'Identity document, selfie and liveness',
      satisfied: identitySatisfied,
      detail: identitySatisfied
        ? 'Your identity checks are approved.'
        : individual?.state === 'IN_REVIEW'
          ? 'Your identity checks are with our review team.'
          : individual?.state === 'DECLINED'
            ? 'Your identity checks were not successful. You can try again.'
            : individual?.state === 'ACTION_REQUIRED'
              ? 'More information is needed to finish your identity checks.'
              : 'Identity verification has not been completed.',
    },
    ...(requireAml
      ? [
          {
            key: 'INDIVIDUAL_AML' as const,
            label: 'Sanctions, PEP and adverse-media screening',
            satisfied: amlSatisfied,
            detail:
              individual?.risk === 'CLEAR'
                ? 'Your screening is clear.'
                : individual?.risk === 'REVIEW' || individual?.risk === 'FLAGGED'
                  ? 'Your screening needs a compliance review. This is not a finding against you.'
                  : 'Screening has not completed.',
          },
        ]
      : []),
  ];
}

function businessRequirements(
  business: (CaseFacts & { registered: boolean }) | null,
  representative: CaseFacts | null,
  options: VerificationPolicyOptions,
): VerificationRequirement[] {
  const registered = business?.registered === true;
  const kybApproved = business?.state === 'APPROVED';
  const businessAmlClear = business?.risk === 'CLEAR';
  const keyPeopleRan = business
    ? business.features.includes('KYB_KEY_PEOPLE')
    : false;

  return [
    {
      key: 'BUSINESS_REGISTRATION',
      label: 'Business registration and supporting documents',
      satisfied: registered && kybApproved,
      detail: !registered
        ? 'Add your registered business details to begin.'
        : kybApproved
          ? 'Your business registration is verified.'
          : business?.state === 'IN_REVIEW'
            ? 'Your business checks are with our review team.'
            : business?.state === 'DECLINED'
              ? 'Your business checks were not successful. Check the details and try again.'
              : business?.state === 'ACTION_REQUIRED'
                ? 'More information is needed about your business.'
                : 'Business verification has not completed.',
    },
    {
      key: 'BUSINESS_AML',
      label: 'Business sanctions and risk screening',
      satisfied: businessAmlClear,
      detail:
        business?.risk === 'CLEAR'
          ? 'Business screening is clear.'
          : business?.risk === 'REVIEW' || business?.risk === 'FLAGGED'
            ? 'Business screening needs a compliance review.'
            : 'Business screening has not completed.',
    },
    ...(options.requireKeyPeople
      ? [
          {
            key: 'BUSINESS_KEY_PEOPLE' as const,
            label: 'Directors, beneficial owners and persons with control',
            satisfied: kybApproved && keyPeopleRan,
            detail:
              kybApproved && keyPeopleRan
                ? 'The people behind the business have been verified.'
                : kybApproved
                  ? 'The provider did not confirm the key-people step. Contact support before submitting.'
                  : 'Key people are verified as part of business verification.',
          },
        ]
      : []),
    {
      key: 'REPRESENTATIVE_IDENTITY',
      label: 'Authorised representative identity',
      satisfied: representative
        ? isIdentityCleared(representative.state)
        : false,
      detail: representative
        ? isIdentityCleared(representative.state)
          ? 'Your personal identity is verified.'
          : 'The account holder must also complete personal identity verification.'
        : 'The account holder must also complete personal identity verification.',
    },
  ];
}

/** Why the account is not yet eligible, in the user's language. */
export function evaluateVerification(
  facts: VerificationFacts,
  options: VerificationPolicyOptions,
): VerificationEvaluation {
  const requirements =
    facts.accountType === 'BUSINESS'
      ? businessRequirements(facts.business, facts.individual, options)
      : individualRequirements(facts.individual, true);

  // Identity alone is enough for the idea-validation tier; the caller chooses the
  // reduced policy with `individualOnlyIdentity`.
  const blockers = requirements
    .filter((requirement) => !requirement.satisfied)
    .map((requirement) => requirement.label);

  return {
    blockers,
    eligible: blockers.length === 0,
    nextAction: nextActionFor(facts, requirements),
    policyVersion: options.policyVersion,
    requirements,
  };
}

/**
 * Identity-only policy used by the idea-validation tier (FR-103 does not require AML
 * before supporting an idea). Kept separate so a caller cannot obtain the funds bar by
 * passing a flag.
 */
export function evaluateIdentityOnly(
  facts: Pick<VerificationFacts, 'individual'>,
  policyVersion: string,
): VerificationEvaluation {
  const requirements = individualRequirements(facts.individual, false);
  const blockers = requirements
    .filter((requirement) => !requirement.satisfied)
    .map((requirement) => requirement.label);
  return {
    blockers,
    eligible: blockers.length === 0,
    nextAction: nextActionFor(
      {
        accountType: 'INDIVIDUAL',
        business: null,
        individual: facts.individual,
      },
      requirements,
    ),
    policyVersion,
    requirements,
  };
}

function nextActionFor(
  facts: VerificationFacts,
  requirements: readonly VerificationRequirement[],
): VerificationNextAction {
  if (requirements.every((requirement) => requirement.satisfied)) return 'none';

  if (facts.accountType === 'BUSINESS' && !facts.business?.registered) {
    return 'complete_business_profile';
  }

  const relevant =
    facts.accountType === 'BUSINESS'
      ? [facts.business, facts.individual]
      : [facts.individual];
  const active = relevant.find(
    (entry) => entry !== null && isActiveState(entry.state),
  );
  if (active?.state === 'IN_REVIEW' || active?.state === 'SUBMITTED') {
    return 'resolve_review';
  }
  if (active) return 'resume';

  const declined = relevant.find(
    (entry) =>
      entry !== null &&
      (entry.state === 'DECLINED' ||
        entry.state === 'EXPIRED' ||
        entry.state === 'ERROR'),
  );
  if (declined) return declined.state === 'ERROR' ? 'contact_support' : 'retry';

  return 'start';
}

/**
 * The campaign gate has a stricter bar than the status screen: a business creator
 * must satisfy the business AND representative requirements, and an individual
 * creator must be funds-cleared (identity + AML). A case must never be treated as
 * verified from a browser redirect.
 */
export function campaignSubmissionBlockers(
  facts: VerificationFacts,
  options: VerificationPolicyOptions,
): string[] {
  return evaluateVerification(facts, options).blockers;
}

/** Backer threshold: below it, no verification; at or above it, funds clearance. */
export function backerVerificationRequired(
  cumulativeUsd: number,
  nextAmountUsd: number,
  thresholdUsd: number,
): boolean {
  if (!Number.isFinite(cumulativeUsd) || !Number.isFinite(nextAmountUsd)) {
    return true; // fail closed on corrupt input
  }
  return cumulativeUsd + nextAmountUsd > thresholdUsd;
}

export function isFundsClearedCase(facts: CaseFacts | null): boolean {
  return facts ? isFundsCleared(facts.state, facts.risk) : false;
}
