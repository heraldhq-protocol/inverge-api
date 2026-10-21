import { createHash } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import {
  EmbeddedWalletInfo,
  EmbeddedWalletPort,
  VerifiedIdentity,
} from './embedded-wallet.port';

// Offline dev adapter. Token format: "stub:<providerUserId>[:<email>]"; bare
// tokens are accepted and hashed so each e2e caller stays a distinct user.
// The derived address is synthetic — AuthService never persists it.
@Injectable()
export class StubWalletAdapter implements EmbeddedWalletPort {
  async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
    if (!token) throw new UnauthorizedException('No token provided');

    const parts = token.split(':');
    const structured = parts[0] === 'stub' && parts.length >= 2;
    const identity = structured ? parts.slice(0, 2).join(':') : token;
    const suppliedEmail = structured ? parts.slice(2).join(':') : undefined;
    const digest = createHash('sha256').update(token).digest('hex').slice(0, 24);

    // The `did:privy:` prefix is preserved so existing dev users and e2e
    // fixtures keep resolving; the column itself is provider-neutral.
    const providerUserId = `did:privy:${identity}`;
    const email =
      suppliedEmail && suppliedEmail.includes('@')
        ? suppliedEmail
        : `stub-${digest}@user.inverge`;

    return { providerUserId, email, wallet: this.derive(providerUserId) };
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
