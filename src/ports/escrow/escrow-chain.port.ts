// Port: the Solana cluster reads the deployment workflow depends on.
// Adapter: a plain JSON-RPC client ("solana-rpc"). There is deliberately no
// adapter that fabricates a confirmed transaction: with the port unconfigured the
// API refuses to prepare a deployment instead of pretending one happened.
//
// Kept narrow on purpose. The workflow needs to (a) read the transaction the
// creator signed, (b) read the Campaign and vault accounts it created, and
// (c) quote rent. It never needs to sign, send, or hold a key (NFR-02).

export type SolanaCluster = 'devnet' | 'mainnet-beta';
export type SolanaCommitment = 'confirmed' | 'finalized';

export const ESCROW_CHAIN_PORT = Symbol('ESCROW_CHAIN_PORT');

export interface ChainInstruction {
  programId: string;
  /** Base58 account addresses, in instruction order. */
  accounts: readonly string[];
  /** Raw instruction data, base64. */
  dataBase64: string;
}

export interface ChainTransaction {
  found: boolean;
  slot: number | null;
  blockTime: number | null;
  success: boolean;
  /** Base58 error code or a short message; null when execution succeeded. */
  error: string | null;
  /** Commitment level the node reported for this response. */
  commitment: string | null;
  instructions: readonly ChainInstruction[];
}

export interface ChainAccount {
  exists: boolean;
  owner: string | null;
  lamports: bigint | null;
  dataBase64: string | null;
}

export interface EscrowChainPort {
  readonly configured: boolean;
  readonly cluster: SolanaCluster;
  readonly programId: string;
  readonly commitment: SolanaCommitment;

  getTransaction(signature: string): Promise<ChainTransaction>;
  getAccount(address: string): Promise<ChainAccount>;
  /** Rent-exemption minimum in lamports for an account of `bytes` bytes. */
  getRentExemptionLamports(bytes: number): Promise<bigint>;
}

/** Raised when the port is intentionally unconfigured; maps to 503, never 500. */
export class ChainNotConfiguredError extends Error {
  constructor(message = 'The Solana cluster is not configured for this deployment.') {
    super(message);
    this.name = 'ChainNotConfiguredError';
  }
}

/** A transient RPC failure after the adapter's own retries were exhausted. */
export class ChainUnavailableError extends Error {
  constructor(message = 'The Solana cluster could not be reached.') {
    super(message);
    this.name = 'ChainUnavailableError';
  }
}
