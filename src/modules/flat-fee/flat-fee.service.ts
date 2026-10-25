import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateChargeInput,
  FLAT_FEE_PAYMENT_PORT,
  FlatFeePaymentPort,
  FlatFeeWebhookEvent,
} from '../../ports/flat-fee/flat-fee-payment.port';
import { WebhookInboxService } from '../../common/webhooks/webhook-inbox.service';
import { FLATFEE_SUCCEEDED, FlatFeeSucceededEvent } from './flat-fee.events';

// The flat-fee rail (FR-406): boosts + application fee, independent of escrow flows.
@Injectable()
export class FlatFeeService {
  constructor(
    @Inject(FLAT_FEE_PAYMENT_PORT) private readonly processor: FlatFeePaymentPort,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    @Optional() private readonly inbox?: WebhookInboxService,
  ) {}

  async createCharge(input: CreateChargeInput) {
    const res = await this.processor.createCharge(input);
    await this.prisma.flatFeeCharge.create({
      data: {
        userId: input.userId,
        purpose: input.purpose,
        amount: input.amount,
        currency: input.currency,
        processorRef: res.processorRef,
        status: 'PENDING',
        metadata: (input.metadata ?? undefined) as object | undefined,
      },
    });
    return res;
  }

  // Idempotent: a charge already out of PENDING is a no-op. Fulfilment (activating a
  // boost, marking an application fee paid) is decoupled via an event so this rail
  // carries no back-dependency on Boosts/Campaigns.
  async handleWebhook(rawBody: string, signature?: string) {
    const evt = this.processor.parseWebhook(rawBody, signature);
    if (!evt) throw new BadRequestException('Invalid or unverifiable webhook');

    if (!this.inbox) return this.applyWebhook(evt);

    return this.inbox.run(
      {
        provider: 'PAYSTACK',
        rawBody,
        // The charge reference is already durable local state, and the status
        // distinguishes a later failed event from the original success.
        dedupeKey: `PAYSTACK:${evt.processorRef}:${evt.status}`,
        eventType: evt.status,
      },
      () => this.applyWebhook(evt),
    );
  }

  private async applyWebhook(evt: FlatFeeWebhookEvent) {
    const charge = await this.prisma.flatFeeCharge.findUnique({
      where: { processorRef: evt.processorRef },
    });
    if (!charge) return { ignored: true };
    if (charge.status !== 'PENDING') return { idempotent: true };

    const status = evt.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
    await this.prisma.flatFeeCharge.update({
      where: { id: charge.id },
      data: { status },
    });

    if (status === 'SUCCEEDED') {
      this.events.emit(FLATFEE_SUCCEEDED, {
        chargeId: charge.id,
        userId: charge.userId,
        purpose: charge.purpose,
        metadata: charge.metadata,
      } satisfies FlatFeeSucceededEvent);
    }
    return { ok: true, status };
  }
}
