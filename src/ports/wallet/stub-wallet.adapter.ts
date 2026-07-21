import { Injectable, UnauthorizedException } from '@nestjs/common';
import {
  EmbeddedWalletInfo,
  EmbeddedWalletPort,
  VerifiedIdentity,
} from './embedded-wallet.port';

// Offline dev adapter. Token format: "stub:<providerUserId>[:<email>]".
// Derives a deterministic pseudo-address so flows are reproducible without Privy.
@Injectable()
export class StubWalletAdapter implements EmbeddedWalletPort {
  async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
    const [scheme, providerUserId, email] = token.split(':');
    if (scheme !== 'stub' || !providerUserId) {
      throw new UnauthorizedException('Invalid stub token (expected "stub:<did>[:<email>]")');
    }
    return {
      providerUserId,
      email: email || undefined,
      wallet: this.derive(providerUserId),
    };
  }

  async getEmbeddedWallet(providerUserId: string): Promise<EmbeddedWalletInfo> {
    return this.derive(providerUserId);
  }

  private derive(seed: string): EmbeddedWalletInfo {
    const b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let h = 0;
    for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    let addr = '';
    for (let i = 0; i < 44; i++) {
      h = (h * 1103515245 + 12345) >>> 0;
      addr += b58[h % b58.length];
    }
    return { address: addr, provider: 'stub' };
  }
}
