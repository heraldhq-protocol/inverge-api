// Port: Solana RPC + event indexer (FR-801–803, NFR-08). Deferred to Phase 2 —
// no on-chain events exist in Phase 0. Reference adapter: Helius. Defined now so the
// IndexerModule has a stable contract to build against later.

export interface IndexedEscrowEvent {
  campaignId: string;
  eventType: 'FUNDED' | 'TRANCHE_RELEASED' | 'REFUND_CLAIMED' | 'MILESTONE_FAILED';
  amount?: number;
  txSignature: string;
  blockTime: Date;
}

export interface ChainIndexerPort {
  /** Fetch escrow-program events since a given signature/slot for reconciliation. */
  fetchEscrowEvents(sinceSignature?: string): Promise<IndexedEscrowEvent[]>;
}

export const CHAIN_INDEXER_PORT = Symbol('CHAIN_INDEXER_PORT');
