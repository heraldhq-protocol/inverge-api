// Port: embedded wallet + auth-token verification (FR-101/102).
// Adapters: MetaMask Embedded Wallets / Web3Auth (web), Privy (legacy), stub (offline).
// The port keeps the vendor swappable; business logic never imports a vendor SDK.

export interface EmbeddedWalletInfo {
  address: string;
  provider: string; // "web3auth" | "privy" | "stub" | ...
}

export interface VerifiedIdentity {
  providerUserId: string; // stable provider subject - maps to User.providerUserId
  email?: string;
  /**
   * True only when the provider's signed token carries a validated
   * `email_verified: true` claim. An email without this flag is a suggestion,
   * never proof of ownership.
   */
  emailVerified?: boolean;
  /**
   * Verified provider profile image URL. Adapters only return a URL they have
   * validated against an allowlist; it is an external reference, not an upload.
   */
  avatarUrl?: string;
  wallet?: EmbeddedWalletInfo;
}

export interface WalletOwnershipProof {
  /**
   * Address the client claims to control. Optional: when supplied, an adapter
   * must confirm it against the signed token, never accept it as given.
   */
  walletAddress?: string;
}

export interface EmbeddedWalletPort {
  /** Verify an access token from the auth/wallet provider and return the identity. */
  verifyAccessToken(token: string, proof?: WalletOwnershipProof): Promise<VerifiedIdentity>;
  /** Fetch the embedded wallet for a provider user id, if the provider exposes one. */
  getEmbeddedWallet(providerUserId: string): Promise<EmbeddedWalletInfo | null>;
}

export const EMBEDDED_WALLET_PORT = Symbol('EMBEDDED_WALLET_PORT');
