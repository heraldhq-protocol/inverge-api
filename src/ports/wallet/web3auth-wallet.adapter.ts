import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { base58ToHex } from '../../common/utils/base58.util';
import { Env } from '../../config/env.validation';
import {
  EmbeddedWalletInfo,
  EmbeddedWalletPort,
  VerifiedIdentity,
  WalletOwnershipProof,
} from './embedded-wallet.port';

const SOLANA_PUBLIC_KEY_BYTES = 32;
/** Tolerated clock drift when rejecting a token whose `iat` is in the future. */
const FUTURE_IAT_TOLERANCE_SECONDS = 60;

/** Wallet entry carried in a Web3Auth identity token. */
interface TokenWalletClaim {
  public_key?: string; // social logins (app key, hex)
  address?: string; // external wallets (on-chain address)
  type?: string;
  curve?: string; // "ed25519" | "secp256k1"
}

type Web3AuthClaims = JWTPayload & {
  userId?: string;
  authConnection?: string;
  email?: string;
  wallets?: TokenWalletClaim[];
};

// Web3Auth (MetaMask Embedded Wallets) adapter. Verifies the ES256 identity
// token against the provider's JWKS — no vendor SDK, so swapping providers stays
// a one-file change. Both `issuer` and `audience` are always checked: all
// projects share signing infrastructure, so without `audience` a token minted
// for another project would verify.
@Injectable()
export class Web3AuthWalletAdapter implements EmbeddedWalletPort {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: ConfigService<Env, true>) {}

  private getJwks(): ReturnType<typeof createRemoteJWKSet> {
    if (!this.jwks) {
      const url = this.config.get('WEB3AUTH_JWKS_URL', { infer: true });
      this.jwks = createRemoteJWKSet(new URL(url));
    }
    return this.jwks;
  }

  private getClientId(): string {
    const clientId = this.config.get('WEB3AUTH_CLIENT_ID', { infer: true });
    if (!clientId) throw new UnauthorizedException('WEB3AUTH_CLIENT_ID is not configured');
    return clientId;
  }

  async verifyAccessToken(
    token: string,
    proof?: WalletOwnershipProof,
  ): Promise<VerifiedIdentity> {
    if (!token) throw new UnauthorizedException('No identity token provided');

    // Resolve configuration before the try so a missing client id or malformed
    // JWKS URL surfaces as itself rather than "invalid token".
    const audience = this.getClientId();
    const jwks = this.getJwks();
    const issuer = this.config.get('WEB3AUTH_TOKEN_ISSUER', { infer: true });

    let payload: Web3AuthClaims;
    try {
      const verified = await jwtVerify(token, jwks, {
        algorithms: ['ES256'],
        issuer,
        audience,
      });
      payload = verified.payload as Web3AuthClaims;
    } catch (error) {
      // Diagnostics stay server-side and never include the token. `jose` names
      // the failed check (issuer, audience, expiry, signature), which is the
      // difference between a configuration mistake and a forged token.
      if (process.env.NODE_ENV !== 'production') {
        const detail =
          error instanceof Error ? `${error.name}: ${error.message}` : 'unknown';
        console.warn('[web3auth] identity token rejected', detail);
      }
      throw new UnauthorizedException('Invalid Web3Auth identity token');
    }

    if (
      typeof payload.iat === 'number' &&
      payload.iat > Math.floor(Date.now() / 1000) + FUTURE_IAT_TOLERANCE_SECONDS
    ) {
      throw new UnauthorizedException('Invalid Web3Auth identity token');
    }

    const providerUserId = this.resolveProviderUserId(payload);
    const wallet = proof?.walletAddress
      ? this.verifyWalletOwnership(payload.wallets ?? [], proof.walletAddress)
      : undefined;

    return {
      providerUserId,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      wallet,
    };
  }

  /**
   * Web3Auth exposes no server-side user lookup without a provider API secret,
   * so there is nothing to fetch here. The address is taken from the signed
   * identity token instead (see `verifyWalletOwnership`).
   */
  async getEmbeddedWallet(): Promise<EmbeddedWalletInfo | null> {
    return null;
  }

  private resolveProviderUserId(payload: Web3AuthClaims): string {
    if (typeof payload.sub === 'string' && payload.sub.length > 0) return payload.sub;

    // Tokens without `sub` still carry the verifier pair; grouping them keeps the
    // identity stable across sign-in methods on the same connection.
    if (
      typeof payload.authConnection === 'string' &&
      typeof payload.userId === 'string' &&
      payload.userId.length > 0
    ) {
      return `${payload.authConnection}|${payload.userId}`;
    }

    throw new UnauthorizedException('Identity token carries no stable subject');
  }

  /**
   * Confirms the claimed address is attested by the signed token. Embedded
   * (social) wallets are proven by their ed25519 app key; external wallets by
   * their on-chain address. A mismatch is rejected rather than ignored.
   */
  private verifyWalletOwnership(
    wallets: TokenWalletClaim[],
    claimedAddress: string,
  ): EmbeddedWalletInfo {
    const address = claimedAddress.trim();
    if (!address) throw new UnauthorizedException('Wallet address is empty');

    let claimedHex: string | undefined;
    try {
      const hex = base58ToHex(address);
      if (hex.length === SOLANA_PUBLIC_KEY_BYTES * 2) claimedHex = hex;
    } catch {
      // Not base58 — it can still match an external wallet's `address` claim.
    }

    const attested = wallets.some((wallet) => {
      if (
        wallet.address &&
        wallet.address.toLowerCase() === address.toLowerCase()
      ) {
        return true;
      }
      const publicKey = wallet.public_key?.toLowerCase().replace(/^0x/, '');
      return claimedHex !== undefined && publicKey === claimedHex;
    });

    if (!attested) {
      throw new UnauthorizedException(
        'Wallet address is not attested by the identity token',
      );
    }

    return { address, provider: 'web3auth' };
  }
}
