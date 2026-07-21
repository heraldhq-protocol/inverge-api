import { FlatFeePurpose } from '../../ports/flat-fee/flat-fee-payment.port';

export const FLATFEE_SUCCEEDED = 'flatfee.succeeded';

export interface FlatFeeSucceededEvent {
  chargeId: string;
  userId: string;
  purpose: FlatFeePurpose;
  metadata: unknown; // e.g. { ideaId, tier } for BOOST
}
