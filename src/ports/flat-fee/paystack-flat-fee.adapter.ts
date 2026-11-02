import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Env } from '../../config/env.validation';
import {
  CreateChargeInput,
  CreateChargeResult,
  FlatFeePaymentPort,
  FlatFeeWebhookEvent,
} from './flat-fee-payment.port';

// Reference adapter: Paystack transaction initialize (REST) + HMAC-SHA512 webhook
// verification. No vendor SDK — swapping to Flutterwave is a one-file change.
@Injectable()
export class PaystackFlatFeeAdapter implements FlatFeePaymentPort {
  private readonly base = 'https://api.paystack.co';

  constructor(private readonly config: ConfigService<Env, true>) {}

  private secret(): string {
    const s = this.config.get('PAYSTACK_SECRET_KEY', { infer: true });
    if (!s) throw new Error('PAYSTACK_SECRET_KEY not configured');
    return s;
  }

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const res = await fetch(`${this.base}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secret()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: input.email ?? `${input.userId}@users.inverge.local`,
        amount: Math.round(input.amount * 100), // kobo
        currency: input.currency,
        metadata: { userId: input.userId, purpose: input.purpose, ...input.metadata },
      }),
    });
    if (!res.ok) {
      throw new Error(`Paystack initialize failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      data: { reference: string; authorization_url: string };
    };
    return {
      processorRef: json.data.reference,
      redirectUrl: json.data.authorization_url,
    };
  }

  parseWebhook(rawBody: string, signature?: string): FlatFeeWebhookEvent | null {
    // Both keys are optional at boot, so an unprovisioned rail must reject
    // callbacks rather than throw on every delivery.
    const secret =
      this.config.get('PAYSTACK_WEBHOOK_SECRET', { infer: true }) ??
      this.config.get('PAYSTACK_SECRET_KEY', { infer: true });
    if (!secret) return null;
    const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
    if (!signature || !this.safeEqual(signature, expected)) return null;

    try {
      const evt = JSON.parse(rawBody);
      const ref = evt?.data?.reference;
      if (!ref) return null;
      return {
        processorRef: ref,
        status: evt.event === 'charge.success' ? 'SUCCEEDED' : 'FAILED',
        raw: evt,
      };
    } catch {
      return null;
    }
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
