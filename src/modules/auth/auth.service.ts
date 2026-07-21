import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  EMBEDDED_WALLET_PORT,
  EmbeddedWalletPort,
} from '../../ports/wallet/embedded-wallet.port';
import { SessionService } from './session.service';

@Injectable()
export class AuthService {
  constructor(
    @Inject(EMBEDDED_WALLET_PORT) private readonly wallet: EmbeddedWalletPort,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  // FR-101: verify provider token, upsert user, provision the embedded wallet,
  // return a short-lived session token.
  async authenticate(accessToken: string) {
    const identity = await this.wallet.verifyAccessToken(accessToken);

    const user = await this.prisma.user.upsert({
      where: { privyDid: identity.providerUserId },
      update: identity.email ? { email: identity.email } : {},
      create: { privyDid: identity.providerUserId, email: identity.email ?? null },
    });

    const embedded =
      identity.wallet ??
      (await this.wallet.getEmbeddedWallet(identity.providerUserId));
    if (embedded) {
      await this.prisma.walletAccount.upsert({
        where: { userId_address: { userId: user.id, address: embedded.address } },
        update: {},
        create: {
          userId: user.id,
          address: embedded.address,
          provider: embedded.provider,
          isEmbedded: true,
          role: 'FUNDING',
        },
      });
    }

    const sessionToken = await this.sessions.sign(user.id);
    return { user, sessionToken };
  }

  me(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: { wallets: true, creatorProfile: true },
    });
  }
}
