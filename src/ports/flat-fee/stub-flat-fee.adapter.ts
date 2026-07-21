import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  CreateChargeInput,
  CreateChargeResult,
  FlatFeePaymentPort,
  FlatFeeWebhookEvent,
} from './flat-fee-payment.port';

// Offline dev adapter. createCharge returns a local "complete" URL; parseWebhook
// trusts a plain JSON body { processorRef, status } (no signature) for local testing.
@Injectable()
export class StubFlatFeeAdapter implements FlatFeePaymentPort {
  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const processorRef = `stub_${randomUUID()}`;
    return {
      processorRef,
      redirectUrl: `http://localhost:3000/dev/flat-fee/complete?ref=${processorRef}&purpose=${input.purpose}`,
    };
  }

  parseWebhook(rawBody: string): FlatFeeWebhookEvent | null {
    try {
      const evt = JSON.parse(rawBody);
      if (!evt?.processorRef) return null;
      return {
        processorRef: evt.processorRef,
        status: evt.status === 'FAILED' ? 'FAILED' : 'SUCCEEDED',
        raw: evt,
      };
    } catch {
      return null;
    }
  }
}
