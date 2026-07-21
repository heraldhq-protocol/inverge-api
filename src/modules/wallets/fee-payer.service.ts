import { Injectable, NotImplementedException } from '@nestjs/common';

// Fee-payer sponsorship (NFR-10). Skeleton only — no on-chain action exists in Phase 0.
// Design constraints to honour when the live path is built (Phase 2):
//   - Sponsor ONLY whitelisted programme IDs (an open fee payer is a drain vector).
//   - NEVER holds authority over escrowed funds — that stays on multisig-controlled
//     programme authorities (NFR-02). Keep this key separate from any escrow authority.
//   - Guard the ATA rent-refund exploit: rate-limit per user and cap sponsorship amounts.
@Injectable()
export class FeePayerService {
  async sponsor(_serializedTx: string, _userId: string): Promise<string> {
    throw new NotImplementedException(
      'Fee-payer sponsorship is a Phase 2 capability (no on-chain action in Phase 0)',
    );
  }
}
