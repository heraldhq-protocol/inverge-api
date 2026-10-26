import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CacheService } from '../../../common/cache/cache.service';
import { Env } from '../../../config/env.validation';
import {
  CreateCampaignDraftDto,
  UpdateCampaignDraftDto,
} from '../dto/campaign-deployment.dto';
import { resolveTaxonomyPair } from '../../taxonomy/taxonomy';
import {
  buildStory,
  campaignEditBlockedReason,
  milestoneRowsFromDto,
  milestoneRowsFromList,
  readStory,
  toDraftResponse,
  type DraftCampaignRow,
} from './campaign-draft.mapper';
import { evaluateDeploymentReadiness, percentToBps } from './campaign-readiness';
import { publicationBlockers } from './deployment-state';
import { resolveTokenMint } from './solana-config';
import { campaignIdHex, campaignTermsHash, toAtomicUnits } from './campaign-terms';

const DRAFT_INCLUDE = {
  deployment: true,
  milestones: true,
} as const;

/**
 * The creator's campaign draft (FR-301). A campaign begins as a persisted draft,
 * not as browser state, so a wallet prompt, a timeout or a closed tab cannot lose
 * the work or force the creator to start again.
 *
 * Every write is owner-scoped and server-validated. Trusted lifecycle fields —
 * status, review status, terms hash, escrow address, deployment and fee state —
 * are never accepted from the request body.
 */
@Injectable()
export class CampaignDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    @Optional() private readonly cache?: CacheService,
  ) {}

  async create(userId: string, dto: CreateCampaignDraftDto) {
    const taxonomy = resolveTaxonomyPair(dto.category, dto.subcategory);
    if (!taxonomy.ok) throw new BadRequestException(taxonomy.reason);

    const campaign = await this.prisma.$transaction(async (tx) => {
      const created = await tx.campaign.create({
        data: {
          creatorId: userId,
          deadline: new Date(dto.deadline),
          draftVersion: 0,
          milestones: { create: milestoneRowsFromDto(dto) },
          objectionWindowDays: dto.objectionWindowDays,
          rewardTiers: toJson(dto.rewardTiers),
          status: 'DRAFT',
          story: toJson(
            buildStory({
              beneficiaries: dto.beneficiaries.trim(),
              eligibility: dto.eligibility?.trim(),
              failurePlan: dto.failurePlan?.trim(),
              heroMedia: dto.heroMedia ?? [],
              location: dto.location.trim(),
              problem: dto.problem.trim(),
              risks: dto.risks?.trim(),
              solution: dto.solution.trim(),
              storyMedia: dto.storyMedia ?? [],
              useOfFunds: (dto.useOfFunds ?? []).map((line) => ({
                amount: line.amount,
                label: line.label.trim(),
              })),
            }),
          ),
          summary: dto.summary.trim(),
          targetAmount: new Prisma.Decimal(dto.targetAmount),
          taxonomyCategorySlug: taxonomy.pair?.category ?? null,
          taxonomySubcategorySlug: taxonomy.pair?.subcategory ?? null,
          title: dto.title.trim(),
          tokenType: dto.tokenType ?? 'USDC',
          workingCapitalPct: new Prisma.Decimal(percentToDecimal(dto.workingCapitalPercent)),
        },
        include: DRAFT_INCLUDE,
      });
      return created;
    });

    this.cache?.bumpEventually('campaigns');
    return this.present(campaign);
  }

  async update(userId: string, campaignId: string, dto: UpdateCampaignDraftDto) {
    const existing = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: DRAFT_INCLUDE,
    });
    if (!existing) throw new NotFoundException('Campaign not found');
    if (existing.creatorId !== userId) throw new ForbiddenException('Not your campaign');

    const blocked = campaignEditBlockedReason({
      deploymentStatus: existing.deployment?.status ?? null,
      reviewStatus: existing.reviewStatus,
      status: existing.status,
    });
    if (blocked) throw new ConflictException(blocked);

    if (dto.category !== undefined || dto.subcategory !== undefined) {
      const taxonomy = resolveTaxonomyPair(
        dto.category ?? existing.taxonomyCategorySlug ?? undefined,
        dto.subcategory ?? existing.taxonomySubcategorySlug ?? undefined,
      );
      if (!taxonomy.ok) throw new BadRequestException(taxonomy.reason);
    }

    const story = mergeStory(existing, dto);

    // Optimistic concurrency: the update only applies when the stored version is
    // the one the client read. A stale tab gets a 409 instead of overwriting a
    // newer edit from another device.
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.campaign.updateMany({
        where: { creatorId: userId, draftVersion: dto.version, id: campaignId },
        data: {
          ...(dto.deadline !== undefined ? { deadline: new Date(dto.deadline) } : {}),
          ...(dto.objectionWindowDays !== undefined
            ? { objectionWindowDays: dto.objectionWindowDays }
            : {}),
          ...(dto.rewardTiers !== undefined ? { rewardTiers: toJson(dto.rewardTiers) } : {}),
          ...(dto.summary !== undefined ? { summary: dto.summary.trim() } : {}),
          ...(dto.targetAmount !== undefined
            ? { targetAmount: new Prisma.Decimal(dto.targetAmount) }
            : {}),
          ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
          ...(dto.tokenType !== undefined ? { tokenType: dto.tokenType } : {}),
          ...(dto.workingCapitalPercent !== undefined
            ? {
                workingCapitalPct: new Prisma.Decimal(
                  percentToDecimal(dto.workingCapitalPercent),
                ),
              }
            : {}),
          ...(dto.category !== undefined || dto.subcategory !== undefined
            ? {
                taxonomyCategorySlug:
                  dto.category ?? existing.taxonomyCategorySlug ?? null,
                taxonomySubcategorySlug:
                  dto.subcategory ?? existing.taxonomySubcategorySlug ?? null,
              }
            : {}),
          draftVersion: { increment: 1 },
          story: toJson(story),
        },
      });

      if (result.count !== 1) return null;

      if (dto.milestones !== undefined) {
        await tx.milestone.deleteMany({ where: { campaignId } });
        await tx.milestone.createMany({
          data: milestoneRowsFromList(dto.milestones).map((row) => ({ ...row, campaignId })),
        });
      }

      return tx.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        include: DRAFT_INCLUDE,
      });
    });

    if (!updated) {
      const current = await this.prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { draftVersion: true },
      });
      throw new ConflictException({
        code: 'STALE_DRAFT_VERSION',
        message:
          'A newer version of this draft was saved elsewhere. Reload before saving your changes.',
        currentVersion: current?.draftVersion ?? null,
      });
    }

    this.cache?.bumpEventually('campaigns');
    this.cache?.bumpEventually('campaign');
    return this.present(updated);
  }

  async getDraft(userId: string, campaignId: string) {
    const campaign = await this.loadOwned(userId, campaignId);
    return this.present(campaign);
  }

  /**
   * Publication is a separate decision from deployment and review. It re-checks
   * every requirement inside one transaction so an approval cannot be raced by a
   * deployment that failed in the meantime (FR-304, FR-305).
   */
  async publish(userId: string, campaignId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.findUnique({
        where: { id: campaignId },
        include: { deployment: true, milestones: { select: { id: true } } },
      });
      if (!campaign) throw new NotFoundException('Campaign not found');
      if (campaign.creatorId !== userId) throw new ForbiddenException('Not your campaign');

      const blockers = publicationBlockers({
        deploymentStatus: campaign.deployment?.status ?? null,
        feeStatus: campaign.deployment?.feeStatus ?? null,
        launchedAt: campaign.launchedAt,
        milestoneCount: campaign.milestones.length,
        reviewStatus: campaign.reviewStatus,
        status: campaign.status,
        termsHash: campaign.termsHash,
      });

      if (blockers.length > 0) {
        throw new BadRequestException({ blockers, message: 'Campaign cannot be published yet' });
      }

      const now = new Date();
      const updated = await tx.campaign.updateMany({
        where: { id: campaignId, launchedAt: null, status: 'IN_REVIEW' },
        data: { launchedAt: now, status: 'ACTIVE' },
      });
      if (updated.count !== 1) {
        throw new ConflictException('The campaign was already published or changed state.');
      }

      if (campaign.deployment) {
        await tx.campaignDeploymentEvent.create({
          data: {
            actorId: userId,
            deploymentId: campaign.deployment.id,
            detail: { launchedAt: now.toISOString() },
            type: 'PUBLISHED',
          },
        });
      }

      return tx.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        include: DRAFT_INCLUDE,
      });
    });

    this.cache?.bumpEventually('campaigns');
    this.cache?.bumpEventually('campaign');
    return this.present(result);
  }

  /** Readiness is computed server-side; the browser only renders the verdict. */
  async readiness(campaign: DraftCampaignRow) {
    const wallet = await this.prisma.walletAccount.findFirst({
      orderBy: [{ isEmbedded: 'desc' }, { createdAt: 'desc' }],
      select: { address: true },
      where: { userId: campaign.creatorId },
    });

    const tokenMint = resolveTokenMint(
      campaign.tokenType,
      this.config.get('SOLANA_CLUSTER', { infer: true }),
      this.config,
    );

    const readiness = evaluateDeploymentReadiness({
      campaign: {
        creatorId: campaign.creatorId,
        deadline: campaign.deadline,
        id: campaign.id,
        milestones: campaign.milestones.map((milestone) => ({
          deliverable: milestone.deliverable,
          evidenceDefinition: milestone.evidenceDefinition,
          expectedAt: milestone.expectedAt,
          index: milestone.index,
          title: milestone.title,
          tranchePct: milestone.tranchePct.toString(),
        })),
        objectionWindowDays: campaign.objectionWindowDays,
        status: campaign.status,
        story: campaign.story,
        summary: campaign.summary,
        targetAmount: campaign.targetAmount.toFixed(2),
        title: campaign.title,
        tokenType: campaign.tokenType,
        workingCapitalPct: campaign.workingCapitalPct.toString(),
      },
      creatorWallet: wallet?.address ?? null,
      tokenMint,
    });

    return { ...readiness, creatorWallet: wallet?.address ?? null, tokenMint };
  }

  /**
   * The terms hash a deployment will commit to. Computed from persisted state, so
   * the value shown before signing is the value the chain will hold.
   *
   * `decimals` is the settlement mint's on-chain exponent; the caller reads it
   * from the cluster so the atomic amount in the hash matches the instruction.
   */
  termsFor(campaign: DraftCampaignRow, decimals: number) {
    const story = readStory(campaign.story);
    return campaignTermsHash({
      campaignId: campaign.id,
      creatorId: campaign.creatorId,
      deadline: campaign.deadline.toISOString(),
      milestones: campaign.milestones
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((milestone) => ({
          deliverable: milestone.deliverable,
          evidence: evidenceText(milestone.evidenceDefinition),
          expectedAt: milestone.expectedAt?.toISOString() ?? null,
          index: milestone.index,
          title: milestone.title,
          trancheBps: percentToBps(milestone.tranchePct.toString()) ?? 0,
        })),
      objectionWindowDays: campaign.objectionWindowDays ?? 0,
      rewardTiers: campaign.rewardTiers ?? null,
      story,
      summary: campaign.summary,
      targetAmountAtomic: toAtomicUnits(campaign.targetAmount.toString(), decimals).toString(),
      title: campaign.title,
      tokenType: campaign.tokenType,
      workingCapitalBps: percentToBps(campaign.workingCapitalPct.toString()) ?? 0,
    });
  }

  campaignIdHex(campaignId: string): string {
    return campaignIdHex(campaignId);
  }

  async loadOwned(userId: string, campaignId: string): Promise<DraftCampaignRow> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: DRAFT_INCLUDE,
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.creatorId !== userId) throw new ForbiddenException('Not your campaign');
    return campaign;
  }

  private async present(campaign: DraftCampaignRow) {
    return {
      ...toDraftResponse(campaign),
      readiness: await this.readiness(campaign),
    };
  }
}

function percentToDecimal(percent: string): string {
  const [whole, fraction = ''] = percent.trim().split('.');
  return `${whole ?? '0'}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

function evidenceText(definition: Prisma.JsonValue): string {
  if (definition && typeof definition === 'object' && !Array.isArray(definition)) {
    const text = (definition as Record<string, unknown>).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  // Round-trips through JSON so a class instance can never reach Prisma's Json
  // writer with prototype properties.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * Merges a partial update onto the stored document. A field the client did not
 * send keeps its stored value; the alternatives (clearing it) would make one
 * autosave from a stale form erase content.
 */
function mergeStory(existing: DraftCampaignRow, dto: UpdateCampaignDraftDto) {
  const current = readStory(existing.story);
  return buildStory({
    beneficiaries: dto.beneficiaries?.trim() ?? current.beneficiaries,
    eligibility: dto.eligibility?.trim() ?? current.eligibility,
    failurePlan: dto.failurePlan?.trim() ?? current.failurePlan,
    heroMedia: dto.heroMedia ?? current.heroMedia,
    location: dto.location?.trim() ?? current.location,
    problem: dto.problem?.trim() ?? current.problem,
    risks: dto.risks?.trim() ?? current.risks,
    solution: dto.solution?.trim() ?? current.solution,
    storyMedia: dto.storyMedia ?? current.storyMedia,
    useOfFunds:
      dto.useOfFunds?.map((line) => ({ amount: line.amount, label: line.label.trim() })) ??
      current.useOfFunds,
  });
}
