// Port: KYC provider (FR-103–105). Phase 0 uses the stub; the reference adapter
// (Smile Identity) goes live at Phase 1 when campaign submission exists.

export interface StartVerificationResult {
  providerRef: string;
  verificationUrl: string;
}

export interface KycWebhookEvent {
  providerRef: string;
  status: 'VERIFIED' | 'REJECTED' | 'PENDING';
  raw: unknown;
}

export interface KycProviderPort {
  startVerification(userId: string): Promise<StartVerificationResult>;
  parseWebhook(rawBody: string, signature?: string): KycWebhookEvent | null;
}

export const KYC_PROVIDER_PORT = Symbol('KYC_PROVIDER_PORT');
