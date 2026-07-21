import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  KYC_PROVIDER_PORT,
  KycProviderPort,
} from '../../ports/kyc/kyc-provider.port';
import { KycStatus } from '../../generated/prisma/client';

@Injectable()
export class KycService {
  constructor(
    @Inject(KYC_PROVIDER_PORT) private readonly provider: KycProviderPort,
    private readonly prisma: PrismaService,
  ) {}

  async status(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { kycStatus: true },
    });
    return { status: u?.kycStatus ?? 'NOT_REQUIRED' };
  }

  async startSession(userId: string) {
    const res = await this.provider.startVerification(userId);
    await this.transition(userId, 'PENDING', res.providerRef);
    return res;
  }

  async handleWebhook(rawBody: string, signature?: string) {
    const evt = this.provider.parseWebhook(rawBody, signature);
    if (!evt) throw new BadRequestException('Invalid or unverifiable webhook');
    const user = await this.prisma.user.findFirst({
      where: { kycProviderRef: evt.providerRef },
    });
    if (!user) return { ignored: true };
    await this.transition(user.id, evt.status as KycStatus, evt.providerRef);
    return { ok: true };
  }

  // FR-105: record status transitions with timestamps. NFR-12: reference only,
  // never raw identity documents.
  private async transition(userId: string, to: KycStatus, providerRef?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.kycStatus === to) return;
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { kycStatus: to, kycProviderRef: providerRef ?? user.kycProviderRef },
      }),
      this.prisma.kycStatusEvent.create({
        data: { userId, fromStatus: user.kycStatus, toStatus: to, providerRef },
      }),
    ]);
  }
}
