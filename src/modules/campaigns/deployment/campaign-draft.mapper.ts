import type { Prisma } from '../../../generated/prisma/client';
import { percentToBps } from './campaign-readiness';
import type { CreateCampaignDraftDto } from '../dto/campaign-deployment.dto';

/**
 * Projection between the creator's authored document and the campaign row.
 *
 * Presentation-only content lives in `Campaign.story` as JSON; columns exist only
 * where the lifecycle, the money or the on-chain terms depend on the value. The
 * mapper is the one place that knows that split.
 */

export type DraftCampaignRow = Prisma.CampaignGetPayload<{
  include: { milestones: true; deployment: true };
}>;

export interface StoryDocument {
  location: string;
  problem: string;
  solution: string;
  beneficiaries: string;
  useOfFunds: { label: string; amount: string }[];
  heroMedia: unknown[];
  storyMedia: unknown[];
  eligibility: string;
  risks: string;
  failurePlan: string;
}

const EMPTY_STORY: StoryDocument = {
  beneficiaries: '',
  eligibility: '',
  failurePlan: '',
  heroMedia: [],
  location: '',
  problem: '',
  risks: '',
  solution: '',
  storyMedia: [],
  useOfFunds: [],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringAt(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

function arrayAt(record: Record<string, unknown> | null, key: string): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

export function readStory(value: Prisma.JsonValue | null): StoryDocument {
  const record = asRecord(value);
  if (!record) return EMPTY_STORY;

  const useOfFunds = arrayAt(record, 'useOfFunds')
    .map((line) => asRecord(line))
    .filter((line): line is Record<string, unknown> => line !== null)
    .map((line) => ({ amount: stringAt(line, 'amount'), label: stringAt(line, 'label') }))
    .filter((line) => line.label.length > 0);

  return {
    beneficiaries: stringAt(record, 'beneficiaries'),
    eligibility: stringAt(record, 'eligibility'),
    failurePlan: stringAt(record, 'failurePlan'),
    heroMedia: arrayAt(record, 'heroMedia'),
    location: stringAt(record, 'location'),
    problem: stringAt(record, 'problem'),
    risks: stringAt(record, 'risks'),
    solution: stringAt(record, 'solution'),
    storyMedia: arrayAt(record, 'storyMedia'),
    useOfFunds,
  };
}

/** Builds the JSON document stored in `Campaign.story` from a create/update body. */
export function buildStory(input: {
  location: string;
  problem: string;
  solution: string;
  beneficiaries: string;
  eligibility?: string;
  risks?: string;
  failurePlan?: string;
  useOfFunds?: { label: string; amount: string }[];
  heroMedia?: unknown[];
  storyMedia?: unknown[];
}): StoryDocument {
  return {
    beneficiaries: input.beneficiaries,
    eligibility: input.eligibility ?? '',
    failurePlan: input.failurePlan ?? '',
    heroMedia: input.heroMedia ?? [],
    location: input.location,
    problem: input.problem,
    risks: input.risks ?? '',
    solution: input.solution,
    storyMedia: input.storyMedia ?? [],
    useOfFunds: input.useOfFunds ?? [],
  };
}

export function milestoneEvidence(evidence: string): { text: string } {
  return { text: evidence.trim() };
}

export function readMilestoneEvidence(value: Prisma.JsonValue): string {
  const record = asRecord(value);
  return stringAt(record, 'text');
}

export function toDraftResponse(campaign: DraftCampaignRow) {
  const story = readStory(campaign.story);
  const deployment = campaign.deployment;

  return {
    category: campaign.taxonomyCategorySlug,
    createdAt: campaign.createdAt,
    creatorId: campaign.creatorId,
    deadline: campaign.deadline,
    deployment: deployment
      ? {
          attemptNo: deployment.attemptNo,
          campaignPda: deployment.campaignPda,
          cluster: deployment.cluster,
          commitment: deployment.commitment,
          feeStatus: deployment.feeStatus,
          id: deployment.id,
          programId: deployment.programId,
          status: deployment.status,
          txSignature: deployment.txSignature,
          updatedAt: deployment.updatedAt,
          verifiedAt: deployment.verifiedAt,
        }
      : null,
    id: campaign.id,
    launchedAt: campaign.launchedAt,
    milestones: campaign.milestones
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((milestone) => ({
        allocationPercent: milestone.tranchePct.toFixed(2),
        deliverable: milestone.deliverable,
        evidence: readMilestoneEvidence(milestone.evidenceDefinition),
        expectedAt: milestone.expectedAt?.toISOString() ?? null,
        id: milestone.id,
        index: milestone.index,
        title: milestone.title,
      })),
    objectionWindowDays: campaign.objectionWindowDays,
    reviewStatus: campaign.reviewStatus,
    rewardTiers: campaign.rewardTiers ?? [],
    status: campaign.status,
    story: {
      beneficiaries: story.beneficiaries,
      eligibility: story.eligibility,
      failurePlan: story.failurePlan,
      heroMedia: story.heroMedia,
      location: story.location,
      problem: story.problem,
      risks: story.risks,
      solution: story.solution,
      storyMedia: story.storyMedia,
      useOfFunds: story.useOfFunds,
    },
    subcategory: campaign.taxonomySubcategorySlug,
    summary: campaign.summary,
    targetAmount: campaign.targetAmount.toFixed(2),
    termsHash: campaign.termsHash,
    title: campaign.title,
    tokenType: campaign.tokenType,
    updatedAt: campaign.updatedAt,
    version: campaign.draftVersion,
    workingCapitalPercent: campaign.workingCapitalPct.toFixed(2),
  };
}

export function milestoneRowsFromList(
  milestones: readonly {
    title: string;
    deliverable: string;
    allocationPercent: string;
    evidence: string;
    expectedAt?: string;
  }[],
): { index: number; title: string; deliverable: string; tranchePct: string; evidenceDefinition: { text: string }; expectedAt: Date | null }[] {
  return milestones.map((milestone, index) => ({
    deliverable: milestone.deliverable.trim(),
    evidenceDefinition: milestoneEvidence(milestone.evidence),
    expectedAt: milestone.expectedAt ? new Date(milestone.expectedAt) : null,
    index,
    title: milestone.title.trim(),
    tranchePct: normaliseTranche(milestone.allocationPercent),
  }));
}

export function milestoneRowsFromDto(input: CreateCampaignDraftDto) {
  return milestoneRowsFromList(input.milestones);
}

/**
 * Stores a tranche as a 2dp percentage string. The programme's integer basis
 * points are derived from this at prepare time; a value that cannot be expressed
 * exactly is rejected by readiness, not silently rounded here.
 */
function normaliseTranche(percent: string): string {
  const bps = percentToBps(percent);
  if (bps === null) return percent;
  return (bps / 100).toFixed(2);
}

export function campaignEditBlockedReason(campaign: {
  status: string;
  reviewStatus: string;
  deploymentStatus: string | null;
}): string | null {
  if (campaign.deploymentStatus === 'CONFIRMED') {
    return 'The escrow is deployed and the campaign terms are immutable (FR-303).';
  }
  if (campaign.status === 'IN_REVIEW' && campaign.reviewStatus !== 'CHANGES_REQUESTED') {
    return 'The campaign is in review. Wait for a decision or a change request before editing.';
  }
  if (campaign.status !== 'DRAFT' && campaign.reviewStatus !== 'CHANGES_REQUESTED') {
    return 'Only a draft, or a campaign with changes requested, can be edited.';
  }
  return null;
}
