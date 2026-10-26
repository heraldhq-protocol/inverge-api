import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { Env } from '../../../config/env.validation';
import {
  ESCROW_CHAIN_PORT,
  ChainNotConfiguredError,
  ChainUnavailableError,
  EscrowChainPort,
} from '../../../ports/escrow/escrow-chain.port';
import {
  CAMPAIGN_ACCOUNT_SIZE,
  CREATE_CAMPAIGN_ACCOUNTS,
  DEFAULT_FEE_BPS,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  decodeMintDecimals,
  encodeCreateCampaignInstruction,
} from './anchor-escrow';
import {
  CAMPAIGN_TERMS_VERSION,
  campaignIdHex,
  campaignTermsHash,
  toAtomicUnits,
} from './campaign-terms';
import { evidenceHash, percentToBps } from './campaign-readiness';
import { CampaignDraftsService } from './campaign-drafts.service';
import {
  extractCreateCampaignAccounts,
  verifyDeployment,
  type ExpectedDeployment,
} from './deployment-verification';
import {
  assertDeploymentTransition,
  type DeploymentStatus,
} from './deployment-state';
import {
  DEPLOYMENT_FEE_POLICY_VERSION,
  buildFeeBreakdown,
  resolveDeploymentFeePolicy,
} from './solana-config';
import {
  FIRST_RECONCILE_DELAY_MS,
  MANUAL_REVIEW_DELAY_MS,
  RECONCILE_MAX_ATTEMPTS,
  nextReconcileAt,
} from './deployment-backoff';

/** The protocol's base signature fee. Priority fees are chosen by the wallet. */
const BASE_SIGNATURE_FEE_LAMPORTS = 5_000n;

const DEPLOYMENT_INCLUDE = {
  campaign: {
    include: { milestones: { orderBy: { index: 'asc' } } },
  },
} as const;

interface StoredExpectation extends ExpectedDeployment {
  floors: { targetAmount: string; floorAmount: string };
}

/**
 * Escrow deployment preparation and verification (FR-303, FR-305).
 *
 * The rules this service is built around:
 * - a transaction signature is not a deployment; only verified on-chain state is;
 * - one campaign has one deployment row, so a retry returns the existing attempt
 *   instead of preparing a second one;
 * - a signature is recorded as an idempotency key and cannot be reused by another
 *   campaign;
 * - an RPC outage leaves the attempt in a reconcilable state, never FAILED.
 */
@Injectable()
export class CampaignDeploymentService {
  private readonly logger = new Logger(CampaignDeploymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly drafts: CampaignDraftsService,
    @Inject(ESCROW_CHAIN_PORT) private readonly chain: EscrowChainPort,
  ) {}

  async prepare(userId: string, campaignId: string, acceptTerms: boolean) {
    if (!acceptTerms) {
      throw new BadRequestException({
        code: 'TERMS_NOT_ACCEPTED',
        message: 'Accept the campaign terms before preparing a deployment.',
      });
    }

    const campaign = await this.drafts.loadOwned(userId, campaignId);
    const readiness = await this.drafts.readiness(campaign);

    if (!readiness.ready) {
      throw new BadRequestException({
        blockers: readiness.blockers,
        checks: readiness.checks,
        code: 'CAMPAIGN_NOT_READY',
        message: 'The campaign is not ready for escrow deployment.',
      });
    }

    if (!this.chain.configured) {
      throw new ServiceUnavailableException({
        code: 'CHAIN_NOT_CONFIGURED',
        message:
          'Escrow deployment is not configured on this deployment. The campaign draft is safe and unchanged.',
      });
    }

    if (readiness.tokenMint === null || readiness.creatorWallet === null) {
      // Readiness already blocks these; kept as a narrowing assertion.
      throw new BadRequestException('The campaign is missing a settlement mint or wallet.');
    }

    const decimals = await this.settlementDecimals(readiness.tokenMint);
    const terms = this.drafts.termsFor(campaign, decimals);
    const idHex = campaignIdHex(campaign.id);
    const targetAtomic = toAtomicUnits(campaign.targetAmount.toString(), decimals);
    // All-or-Nothing: the programme's floor is the target.
    const floorAtomic = targetAtomic;
    const deadlineSeconds = Math.floor(campaign.deadline.getTime() / 1000);

    const expected: StoredExpectation = {
      campaignIdHex: idHex,
      creatorWallet: readiness.creatorWallet,
      deadline: deadlineSeconds,
      floorAmount: floorAtomic,
      floors: { floorAmount: floorAtomic.toString(), targetAmount: targetAtomic.toString() },
      milestones: campaign.milestones
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((milestone) => ({
          // Readiness requires a future date on every milestone.
          deadline: Math.floor((milestone.expectedAt as Date).getTime() / 1000),
          evidenceHash: evidenceHash(milestone.evidenceDefinition),
          trancheBps: percentToBps(milestone.tranchePct.toString()) ?? 0,
        })),
      programId: this.chain.programId,
      targetAmount: targetAtomic,
      termsHash: terms,
      tokenMint: readiness.tokenMint,
      workingCapitalBps: readiness.workingCapitalBps,
    };

    const instructionData = encodeCreateCampaignInstruction({
      campaignId: Buffer.from(idHex, 'hex'),
      customFeeBps: null,
      deadline: expected.deadline,
      floorAmount: expected.floorAmount,
      milestones: expected.milestones,
      targetAmount: expected.targetAmount,
      termsHash: expected.termsHash,
      workingCapitalBps: expected.workingCapitalBps,
    });

    const { fee, feeChargeId } = await this.resolveDeploymentFee(campaign);
    const { rentLamports } = await this.quoteCosts(campaign);

    const feeBreakdown = buildFeeBreakdown({
      feeChargeConfirmed: fee.status === 'CONFIRMED',
      networkFeeLamports: BASE_SIGNATURE_FEE_LAMPORTS,
      platformCharge:
        fee.status === 'CONFIRMED' && fee.amount !== null && fee.currency !== null
          ? { amount: fee.amount.toFixed(2), currency: fee.currency }
          : null,
      policy: resolveDeploymentFeePolicy(this.config),
      rentLamports,
    });

    let deployment: { id: string };
    try {
      deployment = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.campaignDeployment.findUnique({
          where: { campaignId: campaign.id },
        });

        // A signature is already recorded, or the escrow is verified: re-preparing
        // must return that attempt untouched. Overwriting it here would erase the
        // idempotency key for a transaction that may already be on-chain.
        if (
          existing &&
          (existing.status === 'CONFIRMED' || existing.txSignature !== null)
        ) {
          return { id: existing.id };
        }

        const retryAfterFailure = existing?.status === 'FAILED';
        const status: DeploymentStatus = 'READY';
        if (
          existing &&
          existing.status !== 'READY' &&
          existing.status !== 'AWAITING_SIGNATURE'
        ) {
          // FAILED → READY is the only other legal re-entry; everything else was
          // excluded by the guard above.
          assertDeploymentTransition(existing.status, status);
        }

        const data = {
          attemptNo: retryAfterFailure ? existing.attemptNo + 1 : (existing?.attemptNo ?? 1),
          campaignIdBytes: idHex,
          campaignPda: retryAfterFailure ? null : existing?.campaignPda ?? null,
          cluster: this.chain.cluster,
          commitment: this.chain.commitment,
          creatorWallet: expected.creatorWallet,
          escrowVault: retryAfterFailure ? null : existing?.escrowVault ?? null,
          expectedAccounts: toJson({
            accounts: CREATE_CAMPAIGN_ACCOUNTS,
            expected,
            seeds: {
              campaign: ['campaign', idHex],
              config: ['platform_config'],
              escrowVault: ['escrow_vault', '<campaign PDA>'],
            },
          }),
          feeAmount: fee.amount,
          feeBreakdown: toJson(feeBreakdown),
          feeChargeId,
          feeCurrency: fee.currency,
          feeMode: fee.mode,
          feeStatus: fee.status,
          feeVerifiedAt: fee.status === 'CONFIRMED' ? new Date() : null,
          instructionData: Buffer.from(instructionData).toString('base64'),
          lastErrorCode: null,
          lastErrorMessage: null,
          nextReconcileAt: null,
          onChainState: Prisma.DbNull,
          preparedAt: new Date(),
          programId: this.chain.programId,
          reconcileAttempts: 0,
          status,
          termsHash: terms,
          termsVersion: CAMPAIGN_TERMS_VERSION,
          tokenMint: expected.tokenMint,
          txSignature: retryAfterFailure ? null : existing?.txSignature ?? null,
          verifiedAt: null,
        };

        let savedId: string;
        if (existing) {
          // Status is the concurrency token: a submit that moved the row to
          // SUBMITTED between our read and this write makes the update match zero
          // rows, and that attempt is returned instead of being reset.
          const updated = await tx.campaignDeployment.updateMany({
            where: { id: existing.id, status: existing.status },
            data,
          });
          if (updated.count !== 1) return { id: existing.id };
          savedId = existing.id;
        } else {
          const created = await tx.campaignDeployment.create({
            data: { ...data, campaignId: campaign.id },
          });
          savedId = created.id;
        }

        await tx.campaignDeploymentEvent.create({
          data: {
            actorId: userId,
            deploymentId: savedId,
            detail: { attemptNo: data.attemptNo, status },
            fromStatus: existing?.status ?? null,
            toStatus: status,
            type: 'PREPARED',
          },
        });

        await tx.campaignTermsAcceptance.upsert({
          where: {
            campaignId_termsVersion_termsHash: {
              campaignId: campaign.id,
              termsHash: terms,
              termsVersion: CAMPAIGN_TERMS_VERSION,
            },
          },
          update: {},
          create: {
            campaignId: campaign.id,
            termsHash: terms,
            termsVersion: CAMPAIGN_TERMS_VERSION,
            userId,
          },
        });

        return { id: savedId };
      });
    } catch (error) {
      // Two concurrent prepares can both miss the row and race the insert; the
      // unique campaignId decides the winner and the loser reads that attempt.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.campaignDeployment.findUniqueOrThrow({
          where: { campaignId: campaign.id },
        });
        deployment = { id: existing.id };
      } else {
        throw error;
      }
    }

    return this.presentDeployment(deployment.id, readiness);
  }

  async submit(userId: string, campaignId: string, signature: string, attemptId?: string) {
    const deployment = await this.prisma.campaignDeployment.findUnique({
      where: { campaignId },
      include: DEPLOYMENT_INCLUDE,
    });
    if (!deployment) throw new NotFoundException('No deployment has been prepared for this campaign');
    if (deployment.campaign.creatorId !== userId) throw new ForbiddenException('Not your campaign');

    if (attemptId && attemptId !== deployment.id) {
      throw new ConflictException({
        code: 'ATTEMPT_MISMATCH',
        message: 'This signature belongs to a different deployment attempt.',
      });
    }

    if (deployment.txSignature && deployment.txSignature !== signature) {
      throw new ConflictException({
        code: 'SIGNATURE_ALREADY_RECORDED',
        message: 'A different transaction is already recorded for this deployment.',
      });
    }

    if (deployment.status === 'CONFIRMED') {
      return this.presentDeployment(deployment.id);
    }

    if (!deployment.txSignature) {
      if (deployment.status !== 'READY' && deployment.status !== 'AWAITING_SIGNATURE') {
        throw new ConflictException({
          code: 'DEPLOYMENT_NOT_READY',
          message: `Deployment is ${deployment.status.toLowerCase()} and cannot accept a signature.`,
        });
      }

      try {
        await this.prisma.$transaction(async (tx) => {
          const updated = await tx.campaignDeployment.updateMany({
            where: { campaignId, id: deployment.id, txSignature: null },
            data: {
              lastErrorCode: null,
              lastErrorMessage: null,
              nextReconcileAt: new Date(Date.now() + FIRST_RECONCILE_DELAY_MS),
              status: 'SUBMITTED',
              txSignature: signature,
            },
          });
          if (updated.count !== 1) {
            throw new ConflictException('Another signature was recorded first.');
          }

          await tx.campaignDeploymentEvent.create({
            data: {
              actorId: userId,
              deploymentId: deployment.id,
              detail: { signatureMasked: maskSignature(signature) },
              fromStatus: deployment.status,
              toStatus: 'SUBMITTED',
              type: 'SUBMITTED',
            },
          });
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException({
            code: 'SIGNATURE_ALREADY_USED',
            message: 'That transaction signature is already recorded against another campaign.',
          });
        }
        throw error;
      }
    }

    return this.verifyAndPersist(deployment.id);
  }

  async get(userId: string, campaignId: string) {
    const deployment = await this.prisma.campaignDeployment.findUnique({
      where: { campaignId },
      select: { campaign: { select: { creatorId: true } }, id: true },
    });
    if (!deployment) throw new NotFoundException('No deployment has been prepared for this campaign');
    if (deployment.campaign.creatorId !== userId) throw new ForbiddenException('Not your campaign');
    return this.presentDeployment(deployment.id);
  }

  async reconcile(userId: string, campaignId: string) {
    const deployment = await this.prisma.campaignDeployment.findUnique({
      where: { campaignId },
      select: { campaign: { select: { creatorId: true } }, id: true, txSignature: true },
    });
    if (!deployment) throw new NotFoundException('No deployment has been prepared for this campaign');
    if (deployment.campaign.creatorId !== userId) throw new ForbiddenException('Not your campaign');
    if (!deployment.txSignature) {
      throw new ConflictException({
        code: 'NOTHING_TO_RECONCILE',
        message: 'This campaign has no submitted transaction to reconcile.',
      });
    }

    await this.prisma.campaignDeploymentEvent.create({
      data: { actorId: userId, deploymentId: deployment.id, type: 'RECONCILE_REQUESTED' },
    });

    return this.verifyAndPersist(deployment.id);
  }

  /**
   * Reads the chain and records the outcome. Safe to call repeatedly: everything
   * it writes is derived from the stored signature and the cluster's answer.
   */
  async verifyAndPersist(deploymentId: string) {
    const deployment = await this.prisma.campaignDeployment.findUnique({
      where: { id: deploymentId },
      include: DEPLOYMENT_INCLUDE,
    });
    if (!deployment) throw new NotFoundException('Deployment not found');
    if (!deployment.txSignature) {
      throw new ConflictException('No transaction signature has been submitted.');
    }
    if (deployment.status === 'CONFIRMED') return this.presentDeployment(deployment.id);

    if (!this.chain.configured) {
      throw new ServiceUnavailableException({
        code: 'CHAIN_NOT_CONFIGURED',
        message: 'The cluster is not configured, so the transaction cannot be verified yet.',
      });
    }

    const expected = this.storedExpectation(deployment.expectedAccounts);

    if (expected.programId !== this.chain.programId) {
      await this.scheduleReconcile(
        deployment.id,
        'PROGRAM_CONFIGURATION_CHANGED',
        'The configured escrow programme differs from the one this attempt was prepared for. An operator must reconcile it.',
        'NEEDS_RECONCILIATION',
        deployment.reconcileAttempts,
      );
      return this.presentDeployment(deployment.id);
    }

    let transaction;
    try {
      transaction = await this.chain.getTransaction(deployment.txSignature);
    } catch (error) {
      if (error instanceof ChainUnavailableError) {
        await this.scheduleReconcile(
          deployment.id,
          'CHAIN_UNAVAILABLE',
          'The cluster could not be reached. The transaction stays pending until it can be checked.',
          'CONFIRMING',
          deployment.reconcileAttempts,
        );
        return this.presentDeployment(deployment.id);
      }
      throw this.toHttpError(error);
    }

    const accounts = transaction.found
      ? extractCreateCampaignAccounts(transaction, this.chain.programId)
      : null;

    let campaignAccount: Awaited<ReturnType<EscrowChainPort['getAccount']>>;
    let vaultAccount: Awaited<ReturnType<EscrowChainPort['getAccount']>>;
    try {
      [campaignAccount, vaultAccount] = await Promise.all([
        accounts
          ? this.chain.getAccount(accounts.campaignPda)
          : Promise.resolve({ dataBase64: null, exists: false, lamports: null, owner: null }),
        accounts
          ? this.chain.getAccount(accounts.escrowVault)
          : Promise.resolve({ dataBase64: null, exists: false, lamports: null, owner: null }),
      ]);
    } catch (error) {
      if (error instanceof ChainUnavailableError) {
        // The transaction was readable but its accounts were not. That is an
        // outage, not evidence of failure, so the attempt stays pending.
        await this.scheduleReconcile(
          deployment.id,
          'CHAIN_UNAVAILABLE',
          'The cluster could not be reached while reading the campaign accounts. The transaction stays pending.',
          'CONFIRMING',
          deployment.reconcileAttempts,
        );
        return this.presentDeployment(deployment.id);
      }
      throw this.toHttpError(error);
    }

    const result = verifyDeployment({
      campaignAccount,
      expected,
      transaction,
      vaultAccount,
    });

    const now = new Date();
    const pendingVerification = result.verdict === 'pending';
    const reconcileAttempts = pendingVerification
      ? deployment.reconcileAttempts + 1
      : deployment.reconcileAttempts;
    const nextStatus: DeploymentStatus =
      result.verdict === 'confirmed'
        ? 'CONFIRMED'
        : result.verdict === 'failed'
          ? 'FAILED'
          : result.verdict === 'needs_reconciliation'
            ? 'NEEDS_RECONCILIATION'
            : 'CONFIRMING';

    try {
      assertDeploymentTransition(deployment.status, nextStatus);
    } catch {
      // A concurrent worker may already have moved it. Do not regress.
      return this.presentDeployment(deployment.id);
    }

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.campaignDeployment.updateMany({
        where: { id: deployment.id, status: deployment.status },
        data: {
          blockTime: result.blockTime,
          campaignPda: result.campaignPda ?? deployment.campaignPda,
          escrowVault: result.escrowVault ?? deployment.escrowVault,
          lastErrorCode: result.verdict === 'confirmed' ? null : result.code,
          lastErrorMessage: result.verdict === 'confirmed' ? null : result.message,
          nextReconcileAt:
            result.verdict === 'confirmed' || result.verdict === 'failed'
              ? null
              : result.verdict === 'needs_reconciliation'
                ? new Date(Date.now() + MANUAL_REVIEW_DELAY_MS)
                : nextReconcileAt(reconcileAttempts),
          onChainState: result.onChain ? toJson(result.onChain) : undefined,
          reconcileAttempts,
          status: nextStatus,
          verifiedAt: result.verdict === 'confirmed' ? now : deployment.verifiedAt,
        },
      });

      if (updated.count !== 1) return;

      await tx.campaignDeploymentEvent.create({
        data: {
          deploymentId: deployment.id,
          detail: { code: result.code, message: result.message },
          fromStatus: deployment.status,
          toStatus: nextStatus,
          type:
            result.verdict === 'confirmed'
              ? 'CONFIRMED'
              : result.verdict === 'failed'
                ? 'FAILED'
                : result.verdict === 'needs_reconciliation'
                  ? 'NEEDS_RECONCILIATION'
                  : 'SUBMITTED',
        },
      });

      if (result.verdict === 'confirmed') {
        // Link the verified escrow to the campaign in the same transaction that
        // records the confirmation, so a campaign can never look deployed without
        // a verified deployment row.
        await tx.campaign.update({
          where: { id: deployment.campaignId },
          data: {
            escrowPdaAddress: result.campaignPda,
            termsHash: deployment.termsHash,
          },
        });
      }
    });

    return this.presentDeployment(deployment.id);
  }

  /**
   * Bounded sweep for the background worker. Returns redacted counts only, so a
   * scheduler can log progress without reading rows or identifiers.
   */
  async sweepPending(limit = 20): Promise<{ confirmed: number; examined: number; feesSettled: number }> {
    const feesSettled = await this.sweepFees(limit);
    if (!this.chain.configured) return { confirmed: 0, examined: 0, feesSettled };

    const now = new Date();
    const pending = await this.prisma.campaignDeployment.findMany({
      where: {
        nextReconcileAt: { lte: now },
        // Bounded work per sweep, and an attempt that has exhausted its polls
        // waits for an operator instead of occupying the worker forever.
        reconcileAttempts: { lt: RECONCILE_MAX_ATTEMPTS },
        status: { in: ['SUBMITTED', 'CONFIRMING', 'NEEDS_RECONCILIATION'] },
        txSignature: { not: null },
      },
      orderBy: { nextReconcileAt: 'asc' },
      select: { id: true },
      take: Math.min(Math.max(limit, 1), 100),
    });

    let confirmed = 0;
    for (const attempt of pending) {
      try {
        const result = await this.verifyAndPersist(attempt.id);
        if (result.status === 'CONFIRMED') confirmed += 1;
      } catch (error) {
        this.logger.warn(
          `Deployment ${attempt.id} reconciliation failed: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    return { confirmed, examined: pending.length, feesSettled };
  }

  /**
   * A fee can settle after deployment was prepared. Reconciling it never
   * confirms the deployment: the two lifecycles only meet at publication.
   */
  private async sweepFees(limit: number): Promise<number> {
    const pending = await this.prisma.campaignDeployment.findMany({
      where: { feeChargeId: { not: null }, feeStatus: { in: ['PENDING', 'SUBMITTED'] } },
      select: { feeChargeId: true, id: true, status: true },
      take: Math.min(Math.max(limit, 1), 100),
    });

    let settled = 0;
    for (const attempt of pending) {
      if (!attempt.feeChargeId) continue;
      const charge = await this.prisma.flatFeeCharge.findUnique({
        where: { id: attempt.feeChargeId },
        select: { status: true },
      });

      const next =
        charge?.status === 'SUCCEEDED'
          ? 'CONFIRMED'
          : charge?.status === 'FAILED'
            ? 'FAILED'
            : null;
      if (!next) continue;

      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.campaignDeployment.updateMany({
          where: { feeStatus: { in: ['PENDING', 'SUBMITTED'] }, id: attempt.id },
          data: {
            feeStatus: next,
            feeVerifiedAt: next === 'CONFIRMED' ? new Date() : null,
          },
        });
        if (updated.count !== 1) return;
        await tx.campaignDeploymentEvent.create({
          data: {
            deploymentId: attempt.id,
            detail: { chargeStatus: charge?.status ?? 'UNKNOWN' },
            type: next === 'CONFIRMED' ? 'FEE_CONFIRMED' : 'FEE_FAILED',
          },
        });
      });
      if (next === 'CONFIRMED') settled += 1;
    }

    return settled;
  }

  private async scheduleReconcile(
    deploymentId: string,
    code: string,
    message: string,
    status: DeploymentStatus,
    attempts: number,
  ) {
    await this.prisma.campaignDeployment.updateMany({
      // A concurrent worker may have reached a terminal state; never regress it.
      where: { id: deploymentId, status: { notIn: ['CONFIRMED', 'FAILED'] } },
      data: {
        lastErrorCode: code,
        lastErrorMessage: message,
        nextReconcileAt:
          status === 'NEEDS_RECONCILIATION'
            ? new Date(Date.now() + MANUAL_REVIEW_DELAY_MS)
            : nextReconcileAt(attempts + 1),
        reconcileAttempts: { increment: 1 },
        status,
      },
    });
  }

  private storedExpectation(value: Prisma.JsonValue): ExpectedDeployment {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ConflictException('The deployment attempt has no stored expectation.');
    }
    const expected = (value as Record<string, unknown>).expected;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
      throw new ConflictException('The deployment attempt has no stored expectation.');
    }
    const record = expected as Record<string, unknown>;
    return {
      campaignIdHex: String(record.campaignIdHex),
      creatorWallet: String(record.creatorWallet),
      deadline: Number(record.deadline),
      floorAmount: BigInt(String(record.floorAmount)),
      milestones: Array.isArray(record.milestones)
        ? record.milestones.map((milestone) => {
            const entry = milestone as Record<string, unknown>;
            return {
              deadline: Number(entry.deadline),
              evidenceHash: String(entry.evidenceHash),
              trancheBps: Number(entry.trancheBps),
            };
          })
        : [],
      programId: String(record.programId),
      targetAmount: BigInt(String(record.targetAmount)),
      termsHash: String(record.termsHash),
      tokenMint: String(record.tokenMint),
      workingCapitalBps: Number(record.workingCapitalBps),
    };
  }

  private async resolveDeploymentFee(campaign: {
    applicationFeeChargeId: string | null;
    creatorId: string;
    id: string;
  }) {
    const policy = resolveDeploymentFeePolicy(this.config);

    if (policy.mode === 'not_required') {
      return {
        fee: {
          amount: null as Prisma.Decimal | null,
          currency: null as string | null,
          mode: policy.mode,
          status: 'NOT_REQUIRED' as const,
        },
        feeChargeId: null as string | null,
      };
    }

    const chargeId = campaign.applicationFeeChargeId;
    if (!chargeId) {
      throw new ConflictException({
        code: 'DEPLOYMENT_FEE_REQUIRED',
        message:
          'This deployment requires a successful application-fee payment (FR-311). Pay the fee, then prepare again. No transaction has been signed.',
      });
    }

    const charge = await this.prisma.flatFeeCharge.findUnique({ where: { id: chargeId } });
    if (!charge || charge.userId !== campaign.creatorId || charge.purpose !== 'APPLICATION_FEE') {
      throw new ConflictException({
        code: 'DEPLOYMENT_FEE_INVALID',
        message: 'The linked application fee does not belong to this creator.',
      });
    }
    if (charge.status !== 'SUCCEEDED') {
      throw new ConflictException({
        code: 'DEPLOYMENT_FEE_PENDING',
        message: `The application fee is ${charge.status.toLowerCase()}. Deployment waits for it to settle.`,
      });
    }

    return {
      fee: {
        amount: charge.amount,
        currency: charge.currency,
        mode: policy.mode,
        status: 'CONFIRMED' as const,
      },
      feeChargeId: charge.id,
    };
  }

  /**
   * Reads the settlement mint's exponent from the cluster. The amount the creator
   * typed is scaled by this value only; there is no fallback and no cached guess,
   * because either would deploy a campaign worth a different sum.
   */
  private async settlementDecimals(mint: string): Promise<number> {
    let account;
    try {
      account = await this.chain.getAccount(mint);
    } catch (error) {
      throw this.toHttpError(error);
    }

    if (!account.exists) {
      throw new ConflictException({
        code: 'SETTLEMENT_MINT_NOT_FOUND',
        message: `The configured settlement mint ${mint} does not exist on ${this.chain.cluster}.`,
      });
    }
    if (account.owner !== TOKEN_PROGRAM_ID) {
      throw new ConflictException({
        code: 'SETTLEMENT_MINT_UNSUPPORTED',
        message: 'The settlement mint is not a classic SPL token mint (Token-2022 is not supported by the escrow programme).',
      });
    }

    const decimals = account.dataBase64
      ? decodeMintDecimals(Buffer.from(account.dataBase64, 'base64'))
      : null;
    if (decimals === null) {
      throw new ConflictException({
        code: 'SETTLEMENT_MINT_UNDECODABLE',
        message: 'The settlement mint account could not be decoded.',
      });
    }
    return decimals;
  }

  private async quoteCosts(campaign: { id: string }): Promise<{ rentLamports: bigint | null }> {
    try {
      const [campaignRent, vaultRent] = await Promise.all([
        this.chain.getRentExemptionLamports(CAMPAIGN_ACCOUNT_SIZE),
        this.chain.getRentExemptionLamports(TOKEN_ACCOUNT_SIZE),
      ]);
      return { rentLamports: campaignRent + vaultRent };
    } catch (error) {
      if (error instanceof ChainNotConfiguredError) throw this.toHttpError(error);
      if (error instanceof ChainUnavailableError) {
        // Rent is a quote, not a precondition. The creator sees "Unknown" rather
        // than a fabricated number, and the wallet still shows the real cost.
        this.logger.warn(
          `Rent quote unavailable for campaign ${campaign.id}: ${error.message}`,
        );
        return { rentLamports: null };
      }
      throw error;
    }
  }

  private async presentDeployment(
    deploymentId: string,
    readiness?: Awaited<ReturnType<CampaignDraftsService['readiness']>>,
  ) {
    const deployment = await this.prisma.campaignDeployment.findUniqueOrThrow({
      where: { id: deploymentId },
      include: {
        campaign: {
          select: {
            creatorId: true,
            draftVersion: true,
            id: true,
            status: true,
            termsHash: true,
            title: true,
          },
        },
        events: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });

    const breakdown: unknown[] = Array.isArray(deployment.feeBreakdown)
      ? deployment.feeBreakdown
      : [];

    return {
      attemptId: deployment.id,
      attemptNo: deployment.attemptNo,
      blockTime: deployment.blockTime,
      campaign: deployment.campaign,
      campaignIdBytes: deployment.campaignIdBytes,
      campaignPda: deployment.campaignPda,
      canSign: deployment.status === 'READY' || deployment.status === 'AWAITING_SIGNATURE',
      cluster: deployment.cluster,
      commitment: deployment.commitment,
      creatorWallet: deployment.creatorWallet,
      escrowVault: deployment.escrowVault,
      events: deployment.events.map((event) => ({
        at: event.createdAt,
        detail: event.detail,
        toStatus: event.toStatus,
        type: event.type,
      })),
      explorerUrl:
        deployment.txSignature === null
          ? null
          : explorerUrl(deployment.cluster, deployment.txSignature),
      fee: {
        amount: deployment.feeAmount?.toFixed(2) ?? null,
        currency: deployment.feeCurrency,
        lines: breakdown,
        mode: deployment.feeMode,
        policyVersion: DEPLOYMENT_FEE_POLICY_VERSION,
        status: deployment.feeStatus,
        verifiedAt: deployment.feeVerifiedAt,
      },
      instruction: deployment.instructionData
        ? {
            accounts: CREATE_CAMPAIGN_ACCOUNTS,
            dataBase64: deployment.instructionData,
            programId: deployment.programId,
          }
        : null,
      lastError:
        deployment.lastErrorCode === null
          ? null
          : { code: deployment.lastErrorCode, message: deployment.lastErrorMessage },
      onChainState: deployment.onChainState,
      pending: deployment.status !== 'CONFIRMED' && deployment.status !== 'FAILED',
      programId: deployment.programId,
      readiness: readiness ?? null,
      reconcileAttempts: deployment.reconcileAttempts,
      status: deployment.status,
      termsHash: deployment.termsHash,
      termsVersion: deployment.termsVersion,
      tokenMint: deployment.tokenMint,
      txSignature: deployment.txSignature,
      updatedAt: deployment.updatedAt,
      verifiedAt: deployment.verifiedAt,
    };
  }

  private toHttpError(error: unknown) {
    if (error instanceof ChainNotConfiguredError) {
      return new ServiceUnavailableException({
        code: 'CHAIN_NOT_CONFIGURED',
        message: error.message,
      });
    }
    if (error instanceof ChainUnavailableError) {
      return new ServiceUnavailableException({
        code: 'CHAIN_UNAVAILABLE',
        message: 'The cluster could not be reached. The deployment stays pending; try again shortly.',
      });
    }
    return error;
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  // `bigint` cannot be JSON-serialised and is present in the stored expectation
  // (target, floor). Decimal strings survive a round-trip and `storedExpectation`
  // reads them back with `BigInt`, so no precision is lost.
  return JSON.parse(
    JSON.stringify(value, (_key, entry) =>
      typeof entry === 'bigint' ? entry.toString() : entry,
    ),
  ) as Prisma.InputJsonValue;
}

function maskSignature(signature: string): string {
  return signature.length <= 12 ? signature : `${signature.slice(0, 6)}…${signature.slice(-4)}`;
}

export function explorerUrl(cluster: string, signature: string): string {
  const suffix = cluster === 'mainnet-beta' ? '' : `?cluster=${encodeURIComponent(cluster)}`;
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${suffix}`;
}

/** Re-exported so the preparation response's default fee rate is explicit. */
export const DEFAULT_SUCCESS_FEE_BPS = DEFAULT_FEE_BPS;
