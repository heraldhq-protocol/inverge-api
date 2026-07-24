import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { FlatFeeService } from '../flat-fee/flat-fee.service';
import {
  FLATFEE_SUCCEEDED,
  FlatFeeSucceededEvent,
} from '../flat-fee/flat-fee.events';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import { PurchaseBoostDto } from './dto/purchase-boost.dto';

@Injectable()
export class BoostsService {
  private readonly logger = new Logger(BoostsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flatFee: FlatFeeService,
    private readonly params: PlatformParamsService,
  ) {}

  // FR-206: purchase a boost. Returns a payment redirect; the boost is activated only
  // when the flat-fee webhook confirms success (onFlatFeeSucceeded).
  async purchase(userId: string, ideaId: string, dto: PurchaseBoostDto) {
    const idea = await this.prisma.idea.findUnique({
      where: { id: ideaId },
      select: { id: true },
    });
    if (!idea) throw new NotFoundException('Idea not found');

    const priceKey =
      dto.tier === 'FEATURED' ? 'boost.featured.priceUSD' : 'boost.basic.priceUSD';
    const amount = await this.params.getNumber(
      priceKey,
      dto.tier === 'FEATURED' ? 20 : 5,
    );

    const charge = await this.flatFee.createCharge({
      userId,
      purpose: 'BOOST',
      amount,
      currency: 'USD',
      metadata: { ideaId, tier: dto.tier },
    });
    return { redirectUrl: charge.redirectUrl, processorRef: charge.processorRef };
  }

  // FR-206a INVARIANT: activation writes ONLY the IdeaBoost row. It never reads or
  // writes idea.supporterCount / prePledgeTotal / feedbackScore — paid placement is
  // structurally incapable of moving the behavioural validation metrics.
  @OnEvent(FLATFEE_SUCCEEDED)
  async onFlatFeeSucceeded(payload: FlatFeeSucceededEvent) {
    if (payload.purpose !== 'BOOST') return;
    const meta = (payload.metadata ?? {}) as {
      ideaId?: string;
      tier?: 'BASIC' | 'FEATURED';
    };
    if (!meta.ideaId || !meta.tier) {
      this.logger.warn(
        `BOOST charge ${payload.chargeId} missing metadata; skipping activation`,
      );
      return;
    }
    const durKey =
      meta.tier === 'FEATURED'
        ? 'boost.featured.durationDays'
        : 'boost.basic.durationDays';
    const days = await this.params.getNumber(
      durKey,
      meta.tier === 'FEATURED' ? 30 : 7,
    );
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + days * 86_400_000);
    await this.prisma.ideaBoost.create({
      data: {
        ideaId: meta.ideaId,
        purchasedByUserId: payload.userId,
        tier: meta.tier,
        flatFeeChargeId: payload.chargeId,
        startsAt,
        endsAt,
      },
    });
  }

  async active(ideaId: string) {
    const now = new Date();
    return this.prisma.ideaBoost.findFirst({
      where: {
        ideaId,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
