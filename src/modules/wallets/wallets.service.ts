import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LinkWalletDto, WalletRoleValue } from './dto/wallet.dto';

@Injectable()
export class WalletsService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.walletAccount.findMany({ where: { userId } });
  }

  // FR-102: link an external wallet as a funding/payout destination.
  async link(userId: string, dto: LinkWalletDto) {
    // TODO(Phase 0 wiring): verify dto.ownershipSignature against dto.address
    // (ed25519 signed nonce) before trusting the address.
    return this.prisma.walletAccount.upsert({
      where: { userId_address: { userId, address: dto.address } },
      update: { role: dto.role ?? 'PAYOUT' },
      create: {
        userId,
        address: dto.address,
        provider: 'external',
        isEmbedded: false,
        role: dto.role ?? 'PAYOUT',
      },
    });
  }

  async setRole(userId: string, id: string, role: WalletRoleValue) {
    const wallet = await this.prisma.walletAccount.findUnique({ where: { id } });
    if (!wallet || wallet.userId !== userId) {
      throw new NotFoundException('Wallet not found');
    }
    return this.prisma.walletAccount.update({ where: { id }, data: { role } });
  }
}
