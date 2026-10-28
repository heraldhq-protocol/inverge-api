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

/**
 * Prefix of a rejected token's routing claims, for diagnostics only.
 *
 * Decoded without verification and never trusted — logging the *observed*
 * `iss`/`kid` next to the expected ones turns "401 on every login" into a
 * one-line answer. The token itself and the PII claims are never printed.
 */
function describeUnverifiedToken(token: string): string {
  try {
    const [header, payload] = token.split('.');
    const head = JSON.parse(Buffer.from(header, 'base64url').toString()) as {
      alg?: string;
      kid?: string;
    };
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      iss?: string;
      aud?: string | string[];
    };
    const aud = Array.isArray(claims.aud) ? claims.aud.join(',') : claims.aud;
    return `observed alg=${head.alg} kid=${head.kid} iss=${claims.iss} aud=${aud}`;
  } catch {
    return 'observed token=unparsable';
  }
}

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

/** One token family: the issuer claim, and the JWKS that publishes its keys. */
export interface IdentityIssuer {
  issuer: string;
  jwksUrl: string;
}

/**
 * The social-login families MetaMask Embedded Wallets has shipped. They sign
 * with disjoint key sets, and the pair on docs.metamask.io is not the one the
 * current SDK uses: v11 (`@web3auth/modal` >= 11, `getAuthTokenInfo()`) issues
 * `iss: "web3auth.io"` against the citadel JWKS.
 *
 * External-wallet tokens (`iss: https://authjs.web3auth.io`) are deliberately
 * absent: they attest an on-chain address rather than an app key, which is a
 * different identity model from the one this service links.
 */
const SOCIAL_TOKEN_FAMILIES: readonly IdentityIssuer[] = [
  {
    issuer: 'web3auth.io',
    jwksUrl: 'https://api.web3auth.io/citadel-service/.well-known/jwks.json',
  },
  {
    issuer: 'https://api-auth.web3auth.io',
    jwksUrl: 'https://api-auth.web3auth.io/jwks',
  },
];

/**
 * Accepted issuers, configured pair first.
 *
 * A deployment whose env still pins the pre-v11 pair — or whose SDK is upgraded
 * across the family boundary — verifies against the other family instead of
 * failing every login. `audience`, `alg` and expiry are unchanged, so this only
 * widens which Web3Auth endpoint may have signed the token, never who it is for.
 */
export function resolveIdentityIssuers(
  configured: IdentityIssuer,
  families: readonly IdentityIssuer[] = SOCIAL_TOKEN_FAMILIES,
): IdentityIssuer[] {
  return [
    configured,
    ...families.filter(
      (family) =>
        family.issuer !== configured.issuer && family.jwksUrl !== configured.jwksUrl,
    ),
  ];
}

// Web3Auth (MetaMask Embedded Wallets) adapter. Verifies the ES256 identity
// token against the provider's JWKS — no vendor SDK, so swapping providers stays
// a one-file change. Both `issuer` and `audience` are always checked: all
// projects share signing infrastructure, so without `audience` a token minted
// for another project would verify.
@Injectable()
export class Web3AuthWalletAdapter implements EmbeddedWalletPort {
  private readonly jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    /** Pin the accepted families; defaults to the configured pair plus the other known one. */
    private readonly issuers?: readonly IdentityIssuer[],
  ) {}

  private jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
    let set = this.jwks.get(url);
    if (!set) {
      set = createRemoteJWKSet(new URL(url));
      this.jwks.set(url, set);
    }
    return set;
  }

  private candidateIssuers(): IdentityIssuer[] {
    if (this.issuers) return [...this.issuers];
    return resolveIdentityIssuers({
      issuer: this.config.get('WEB3AUTH_TOKEN_ISSUER', { infer: true }),
      jwksUrl: this.config.get('WEB3AUTH_JWKS_URL', { infer: true }),
    });
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
    const candidates = this.candidateIssuers();

    let payload: Web3AuthClaims | undefined;
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        const verified = await jwtVerify(token, this.jwksFor(candidate.jwksUrl), {
          algorithms: ['ES256'],
          issuer: candidate.issuer,
          audience,
        });
        payload = verified.payload as Web3AuthClaims;
        if (candidate !== candidates[0]) {
          console.info(
            `[web3auth] identity token verified with issuer=${candidate.issuer}, not the configured primary`,
          );
        }
        break;
      } catch (error) {
        const detail =
          error instanceof Error ? `${error.name}: ${error.message}` : 'unknown';
        failures.push(`${candidate.issuer} -> ${detail}`);
      }
    }

    if (!payload) {
      // Diagnostics stay server-side and never include the token: the jose
      // failure names the check that failed, and the observed iss/kid/aud show
      // which token family actually arrived. Logged in production too — a bare
      // 401 otherwise leaves the deploy with no way to tell which side is wrong.
      // Audience is the public client id; the token itself is never printed.
      console.warn(
        `[web3auth] identity token rejected; tried ${failures.join(' | ')}; ` +
          `expected audience=${audience}; ${describeUnverifiedToken(token)}`,
      );
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
