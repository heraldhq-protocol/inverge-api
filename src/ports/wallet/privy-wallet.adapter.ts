import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Env } from '../../config/env.validation';
import {
  EmbeddedWalletInfo,
  EmbeddedWalletPort,
  VerifiedIdentity,
} from './embedded-wallet.port';

// Reference adapter: verifies Privy access tokens against Privy's JWKS via `jose`
// (no vendor SDK, so swapping providers stays a one-file change). The JWKS set is
// built lazily so this adapter never throws at construction when unused.
@Injectable()
export class PrivyWalletAdapter implements EmbeddedWalletPort {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: ConfigService<Env, true>) {}

  private getJwks() {
    if (!this.jwks) {
      const url = this.config.get('PRIVY_JWKS_URL', { infer: true });
      if (!url) throw new UnauthorizedException('PRIVY_JWKS_URL not configured');
      this.jwks = createRemoteJWKSet(new URL(url));
    }
    return this.jwks;
  }

  async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.getJwks(), {
        issuer: this.config.get('PRIVY_TOKEN_ISSUER', { infer: true }),
        audience: this.config.get('PRIVY_APP_ID', { infer: true }),
      });
      return {
        providerUserId: payload.sub as string,
        email: (payload as Record<string, unknown>).email as string | undefined,
        // Privy access tokens don't carry the wallet; resolved via getEmbeddedWallet.
      };
    } catch {
      throw new UnauthorizedException('Invalid Privy access token');
    }
  }

  async getEmbeddedWallet(_providerUserId: string): Promise<EmbeddedWalletInfo | null> {
    // TODO(Phase 0 wiring): call Privy's user API to read the embedded Solana wallet.
    // Kept null here so the port is honest until the API call is wired.
    return null;
  }
}
