import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type { Env } from '../../config/env.validation';
import { assertStubProviderAllowed } from '../stub-guard';
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
  constructor(
    @Optional() private readonly config?: ConfigService<Env, true>,
  ) {}

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    assertStubProviderAllowed('flat-fee', this.config);
    const processorRef = `stub_${randomUUID()}`;
    return {
      processorRef,
      redirectUrl: `http://localhost:3000/dev/flat-fee/complete?ref=${processorRef}&purpose=${input.purpose}`,
    };
  }

  parseWebhook(rawBody: string): FlatFeeWebhookEvent | null {
    // An unsigned success body is the whole point of the offline adapter; it must
    // never be accepted by a production process (audit F-01).
    assertStubProviderAllowed('flat-fee', this.config);
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
