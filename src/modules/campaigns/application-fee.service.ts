import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { FlatFeeService } from '../flat-fee/flat-fee.service';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import { VerificationService } from '../kyc/verification.service';
import {
  APPLICATION_FEE_CURRENCY,
  APPLICATION_FEE_FALLBACK_AMOUNT,
  APPLICATION_FEE_PARAM,
} from './application-fee.constants';

const CHARGE_SELECT = {
  amount: true,
  currency: true,
  id: true,
  redirectUrl: true,
  status: true,
} as const;

export type ApplicationFeeStatus = 'NONE' | 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface ApplicationFeeView {
  chargeId: string | null;
  status: ApplicationFeeStatus;
  amount: number;
  currency: string;
  redirectUrl: string | null;
  alreadyPaid: boolean;
}

/**
 * FR-311: starts (or resumes) the one application-fee charge a campaign may
 * have. The charge is bound to the campaign in its metadata before the provider
 * checkout URL is returned, so a successful webhook makes the submit gate pass
 * without a second, campaign-aware fulfilment path.
 *
 * The fee is non-refundable, so a charge is never created for a creator the
 * verification domain would refuse at submission. An already-successful charge
 * is returned regardless of the campaign's later state: the money was taken.
 */
@Injectable()
export class ApplicationFeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flatFee: FlatFeeService,
    private readonly params: PlatformParamsService,
    private readonly verification: VerificationService,
    @Optional() private readonly cache?: CacheService,
  ) {}

  async getOrCreate(
    userId: string,
    campaignId: string,
  ): Promise<ApplicationFeeView> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        applicationFeeChargeId: true,
        creator: { select: { email: true } },
        creatorId: true,
        id: true,
        reviewStatus: true,
        status: true,
      },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.creatorId !== userId) {
      throw new ForbiddenException('Not your campaign');
    }

    const amount = await this.price();
    const existing = campaign.applicationFeeChargeId
      ? await this.prisma.flatFeeCharge.findUnique({
          where: { id: campaign.applicationFeeChargeId },
          select: CHARGE_SELECT,
        })
      : null;

    if (existing?.status === 'SUCCEEDED') {
      return this.present(existing, amount, true);
    }

    this.assertEditable(campaign);

    const gate = await this.verification.campaignGate(userId);
    if (!gate.eligible) {
      throw new BadRequestException({
        blockers: gate.blockers,
        code: gate.code ?? 'VERIFICATION_REQUIRED',
        message: 'Complete verification before paying the application fee',
      });
    }

    if (existing?.status === 'PENDING') {
      if (!existing.redirectUrl) {
        throw new ConflictException({
          code: 'APPLICATION_FEE_PAYMENT_PENDING',
          message:
            'An application-fee payment is already in progress but has no resumable checkout URL. Contact support before paying again.',
        });
      }
      return this.present(existing, amount, false);
    }

    const created = await this.flatFee.createCharge({
      amount,
      currency: APPLICATION_FEE_CURRENCY,
      ...(campaign.creator.email ? { email: campaign.creator.email } : {}),
      metadata: { campaignId },
      purpose: 'APPLICATION_FEE',
      userId,
    });

    // The link is the idempotency boundary: only one charge can be attached to
    // a campaign (`Campaign.applicationFeeChargeId` is unique). A concurrent
    // request loses here; its provider checkout was never returned, so it is
    // retired and the winner's charge is returned instead.
    const linked = await this.prisma.campaign.updateMany({
      where: {
        applicationFeeChargeId: campaign.applicationFeeChargeId ?? null,
        creatorId: userId,
        id: campaignId,
      },
      data: { applicationFeeChargeId: created.chargeId },
    });

    if (linked.count !== 1) {
      await this.flatFee.voidCharge(created.chargeId);
      const winner = await this.currentCharge(campaignId);
      if (winner?.status === 'PENDING' || winner?.status === 'SUCCEEDED') {
        return this.present(winner, amount, winner.status === 'SUCCEEDED');
      }
      throw new ConflictException({
        code: 'APPLICATION_FEE_NOT_LINKED',
        message:
          'The application fee changed while this request was in flight. Reload the campaign before trying again.',
      });
    }

    this.cache?.bumpEventually('campaigns');
    this.cache?.bumpEventually('campaign');

    return {
      alreadyPaid: false,
      amount,
      chargeId: created.chargeId,
      currency: APPLICATION_FEE_CURRENCY,
      redirectUrl: created.redirectUrl,
      status: 'PENDING',
    };
  }

  private async price(): Promise<number> {
    const amount = await this.params.getNumber(
      APPLICATION_FEE_PARAM,
      APPLICATION_FEE_FALLBACK_AMOUNT,
    );
    if (!Number.isFinite(amount) || amount <= 0 || amount > 99_999_999.99) {
      throw new InternalServerErrorException(
        'The application fee is not configured correctly',
      );
    }
    return amount;
  }

  private assertEditable(campaign: {
    status: string;
    reviewStatus: string;
  }): void {
    const resubmission =
      campaign.status === 'IN_REVIEW' &&
      campaign.reviewStatus === 'CHANGES_REQUESTED';
    if (campaign.status !== 'DRAFT' && !resubmission) {
      throw new ConflictException(
        'The application fee can only be paid for a draft or a campaign with changes requested',
      );
    }
  }

  private async currentCharge(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { applicationFeeChargeId: true },
    });
    if (!campaign?.applicationFeeChargeId) return null;
    return this.prisma.flatFeeCharge.findUnique({
      where: { id: campaign.applicationFeeChargeId },
      select: CHARGE_SELECT,
    });
  }

  private present(
    charge: {
      id: string;
      status: string;
      amount: { toString(): string } | number;
      currency: string;
      redirectUrl: string | null;
    },
    fallbackAmount: number,
    alreadyPaid: boolean,
  ): ApplicationFeeView {
    return {
      alreadyPaid,
      amount: Number(charge.amount ?? fallbackAmount),
      chargeId: charge.id,
      currency: charge.currency || APPLICATION_FEE_CURRENCY,
      redirectUrl: charge.redirectUrl ?? null,
      status: charge.status as ApplicationFeeStatus,
    };
  }
}
