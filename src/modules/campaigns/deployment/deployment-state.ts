import {
  CampaignDeploymentFeeStatus,
  CampaignDeploymentStatus,
} from '../../../generated/prisma/client';

/**
 * The deployment and fee state machines (Phase B of the brief).
 *
 * Campaign lifecycle, escrow deployment and fee payment are three axes:
 *
 *   Campaign.status        DRAFT → IN_REVIEW → ACTIVE/FUNDED/FAILED/COMPLETED
 *   Campaign.reviewStatus  NOT_SUBMITTED → IN_REVIEW → APPROVED/... (FR-304)
 *   deployment.status      NOT_STARTED → … → CONFIRMED (this file)
 *   deployment.feeStatus   NOT_REQUIRED | PENDING → CONFIRMED (this file)
 *
 * Publication reads all of them; none of them is inferred from another. A
 * campaign can stay a DRAFT with a READY deployment, and a CONFIRMED deployment
 * does not publish anything by itself.
 */

export type DeploymentStatus = CampaignDeploymentStatus;
export type DeploymentFeeStatus = CampaignDeploymentFeeStatus;

/**
 * Allowed transitions. Anything not listed is a programming error, not a
 * recoverable user action, so `assertDeploymentTransition` throws rather than
 * silently writing an impossible state.
 */
const DEPLOYMENT_TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  NOT_STARTED: ['READY', 'FAILED'],
  READY: ['AWAITING_SIGNATURE', 'FAILED', 'NEEDS_RECONCILIATION'],
  AWAITING_SIGNATURE: ['SUBMITTED', 'READY', 'FAILED', 'NEEDS_RECONCILIATION'],
  // A submitted signature may already have landed even when the submit response
  // was lost, so SUBMITTED can only fail after the chain has been consulted.
  SUBMITTED: ['CONFIRMING', 'CONFIRMED', 'FAILED', 'NEEDS_RECONCILIATION'],
  CONFIRMING: ['CONFIRMED', 'FAILED', 'NEEDS_RECONCILIATION'],
  // Confirmed is terminal for this attempt. A new deployment on the same
  // campaign must never be created automatically.
  CONFIRMED: [],
  FAILED: ['READY', 'NEEDS_RECONCILIATION'],
  NEEDS_RECONCILIATION: ['CONFIRMING', 'CONFIRMED', 'FAILED'],
};

export function canTransitionDeployment(
  from: DeploymentStatus,
  to: DeploymentStatus,
): boolean {
  return DEPLOYMENT_TRANSITIONS[from].includes(to);
}

export function assertDeploymentTransition(
  from: DeploymentStatus,
  to: DeploymentStatus,
): void {
  if (!canTransitionDeployment(from, to)) {
    throw new Error(`Illegal campaign deployment transition: ${from} → ${to}`);
  }
}

/** States in which a creator may still complete the flow without a new attempt. */
export function isOpenDeployment(status: DeploymentStatus): boolean {
  return (
    status === 'READY' ||
    status === 'AWAITING_SIGNATURE' ||
    status === 'SUBMITTED' ||
    status === 'CONFIRMING' ||
    status === 'NEEDS_RECONCILIATION'
  );
}

/** States after which the same attempt can never change on its own. */
export function isTerminalDeployment(status: DeploymentStatus): boolean {
  return status === 'CONFIRMED' || status === 'FAILED';
}

/**
 * A submitted signature must not be reported as failed until the chain has been
 * consulted. This is the guard that stops an RPC timeout from telling a creator
 * that their transaction failed when it may have succeeded.
 */
export function classifySubmitOutcome(input: {
  transactionFound: boolean;
  executionError: string | null;
  accountVerified: boolean;
}): DeploymentStatus {
  if (!input.transactionFound) return 'CONFIRMING';
  if (input.executionError !== null) return 'FAILED';
  return input.accountVerified ? 'CONFIRMED' : 'NEEDS_RECONCILIATION';
}

/** The fee is independent; a confirmed fee never confirms a deployment. */
export function feeSatisfied(status: DeploymentFeeStatus): boolean {
  return status === 'NOT_REQUIRED' || status === 'CONFIRMED';
}

export function canTransitionFee(
  from: DeploymentFeeStatus,
  to: DeploymentFeeStatus,
): boolean {
  if (from === to) return true;
  switch (from) {
    case 'NOT_REQUIRED':
      return false;
    case 'PENDING':
      return to === 'SUBMITTED' || to === 'CONFIRMED' || to === 'FAILED';
    case 'SUBMITTED':
      return to === 'CONFIRMED' || to === 'FAILED' || to === 'NEEDS_RECONCILIATION';
    case 'CONFIRMED':
      return false;
    case 'FAILED':
      return to === 'PENDING' || to === 'NEEDS_RECONCILIATION';
    case 'NEEDS_RECONCILIATION':
      return to === 'CONFIRMED' || to === 'FAILED' || to === 'PENDING';
  }
}

/**
 * Publication eligibility (FR-304 + FR-305). Every reason is stated so the
 * creator sees what is outstanding rather than a generic rejection.
 *
 * This is intentionally stricter than "the transaction confirmed": curated
 * review must have approved the campaign, and the deployment must be verified
 * against chain state.
 */
export interface PublicationFacts {
  status: string;
  reviewStatus: string;
  deploymentStatus: DeploymentStatus | null;
  feeStatus: DeploymentFeeStatus | null;
  termsHash: string | null;
  milestoneCount: number;
  launchedAt: Date | null;
}

export function publicationBlockers(facts: PublicationFacts): string[] {
  const blockers: string[] = [];

  if (facts.launchedAt !== null) {
    blockers.push('The campaign is already published.');
  }
  if (facts.status !== 'IN_REVIEW') {
    blockers.push('The campaign must be in review before it can be published.');
  }
  if (facts.reviewStatus !== 'APPROVED') {
    blockers.push('Curation review has not approved this campaign (FR-304).');
  }
  if (facts.deploymentStatus !== 'CONFIRMED') {
    blockers.push(
      'The escrow deployment has not been verified on-chain (FR-303, FR-305).',
    );
  }
  if (!facts.termsHash) {
    blockers.push('The campaign terms have no content hash (FR-303).');
  }
  if (facts.milestoneCount < 2) {
    blockers.push('The campaign needs at least two milestones (FR-301).');
  }
  if (facts.feeStatus !== null && !feeSatisfied(facts.feeStatus)) {
    blockers.push('The deployment fee has not been confirmed.');
  }

  return blockers;
}
