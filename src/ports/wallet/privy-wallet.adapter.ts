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
      let url = this.config.get('PRIVY_JWKS_URL', { infer: true });
      if (!url) {
        const appId = this.config.get('PRIVY_APP_ID', { infer: true });
        if (appId) {
          url = `https://auth.privy.io/api/v1/apps/${appId}/jwks.json`;
        }
      }
      if (!url) throw new UnauthorizedException('PRIVY_JWKS_URL or PRIVY_APP_ID not configured');
      this.jwks = createRemoteJWKSet(new URL(url));
    }
    return this.jwks;
  }

  async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
    try {
      const appId = this.config.get('PRIVY_APP_ID', { infer: true });
      const { payload } = await jwtVerify(token, this.getJwks(), {
        audience: appId,
      });
      const providerUserId = payload.sub as string;
      let email = (payload as Record<string, unknown>).email as string | undefined;

      let wallet: EmbeddedWalletInfo | undefined;
      if (providerUserId) {
        const embedded = await this.getEmbeddedWallet(providerUserId);
        if (embedded) wallet = embedded;
      }

      return {
        providerUserId,
        email,
        wallet,
      };
    } catch (err) {
      throw new UnauthorizedException('Invalid Privy access token');
    }
  }

  async getEmbeddedWallet(providerUserId: string): Promise<EmbeddedWalletInfo | null> {
    const appId = this.config.get('PRIVY_APP_ID', { infer: true });
    const appSecret = this.config.get('PRIVY_APP_SECRET', { infer: true });
    if (!appId || !appSecret) return null;

    try {
      const authHeader = `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`;
      const res = await fetch(`https://auth.privy.io/api/v1/users/${providerUserId}`, {
        headers: {
          Authorization: authHeader,
          'privy-app-id': appId,
        },
      });

      if (!res.ok) return null;
      const data = (await res.json()) as {
        linked_accounts?: Array<{
          type: string;
          address?: string;
          chain_type?: string;
          wallet_client_type?: string;
        }>;
      };

      if (!data.linked_accounts) return null;

      // Search for Solana embedded wallet or any embedded wallet
      const solanaWallet = data.linked_accounts.find(
        (acc) => acc.type === 'wallet' && (acc.chain_type === 'solana' || acc.wallet_client_type === 'privy'),
      );

      const anyWallet = solanaWallet ?? data.linked_accounts.find((acc) => acc.type === 'wallet');

      if (anyWallet?.address) {
        return {
          address: anyWallet.address,
          provider: 'privy',
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}
