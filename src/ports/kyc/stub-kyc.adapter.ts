import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  KycProviderPort,
  KycWebhookEvent,
  StartVerificationResult,
} from './kyc-provider.port';

// Offline dev adapter. Phase 0 keeps KYC as scaffold only (FR-103 gates campaign
// submission, which does not exist yet). Webhook body: { providerRef, status }.
@Injectable()
export class StubKycAdapter implements KycProviderPort {
  async startVerification(userId: string): Promise<StartVerificationResult> {
    const providerRef = `stubkyc_${randomUUID()}`;
    return {
      providerRef,
      verificationUrl: `http://localhost:3000/dev/kyc/complete?ref=${providerRef}&user=${userId}`,
    };
  }

  parseWebhook(rawBody: string): KycWebhookEvent | null {
    try {
      const evt = JSON.parse(rawBody);
      if (!evt?.providerRef) return null;
      const status: KycWebhookEvent['status'] =
        evt.status === 'REJECTED'
          ? 'REJECTED'
          : evt.status === 'PENDING'
            ? 'PENDING'
            : 'VERIFIED';
      return { providerRef: evt.providerRef, status, raw: evt };
    } catch {
      return null;
    }
  }
}
