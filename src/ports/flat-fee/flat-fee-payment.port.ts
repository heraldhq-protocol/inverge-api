// Port: flat-fee card/local-rail processor (FR-206/406) — the rail that is
// deliberately separate from the stablecoin on/off-ramp VASP. Reference adapter: Paystack.

export type FlatFeePurpose = 'BOOST' | 'APPLICATION_FEE';

export interface CreateChargeInput {
  userId: string;
  purpose: FlatFeePurpose;
  amount: number; // major currency units (e.g. NGN)
  currency: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateChargeResult {
  processorRef: string;
  redirectUrl: string;
}

export interface FlatFeeWebhookEvent {
  processorRef: string;
  status: 'SUCCEEDED' | 'FAILED';
  raw: unknown;
}

export interface FlatFeePaymentPort {
  createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;
  /** Verify signature + normalize a raw webhook body. Returns null if the signature is invalid. */
  parseWebhook(rawBody: string, signature?: string): FlatFeeWebhookEvent | null;
}

export const FLAT_FEE_PAYMENT_PORT = Symbol('FLAT_FEE_PAYMENT_PORT');
