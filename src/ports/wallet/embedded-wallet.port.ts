// Port: embedded wallet + auth-token verification (FR-101/102).
// Reference adapter is Privy; the port keeps the vendor swappable.

export interface EmbeddedWalletInfo {
  address: string;
  provider: string; // "privy" | "stub" | ...
}

export interface VerifiedIdentity {
  providerUserId: string; // e.g. Privy DID — maps to User.privyDid
  email?: string;
  wallet?: EmbeddedWalletInfo;
}

export interface EmbeddedWalletPort {
  /** Verify an access token from the auth/wallet provider and return the identity. */
  verifyAccessToken(token: string): Promise<VerifiedIdentity>;
  /** Fetch the embedded wallet for a provider user id, if the provider exposes one. */
  getEmbeddedWallet(providerUserId: string): Promise<EmbeddedWalletInfo | null>;
}

export const EMBEDDED_WALLET_PORT = Symbol('EMBEDDED_WALLET_PORT');
