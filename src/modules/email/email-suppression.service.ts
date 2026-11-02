import { Injectable } from '@nestjs/common';
import type { EmailSuppressionReason } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeEmail } from '../auth/email/email-normalization';

/**
 * A hard bounce or complaint blocks every category and must never be
 * downgraded by an unsubscribe. `MANUAL` sits between: an operator block is
 * stronger than a marketing opt-out but weaker than a provider fact.
 */
const REASON_RANK: Record<EmailSuppressionReason, number> = {
  UNSUBSCRIBED: 1,
  MANUAL: 2,
  COMPLAINT: 3,
  HARD_BOUNCE: 4,
};

@Injectable()
export class EmailSuppressionService {
  constructor(private readonly prisma: PrismaService) {}

  async block(
    email: string,
    reason: EmailSuppressionReason,
    source: string,
  ): Promise<void> {
    const normalized = normalizeEmail(email);
    if (!normalized) return;
    const existing = await this.prisma.emailSuppression.findUnique({
      where: { email: normalized },
      select: { reason: true },
    });
    if (!existing) {
      await this.prisma.emailSuppression
        .create({ data: { email: normalized, reason, source } })
        .catch(() => undefined);
      return;
    }
    if (REASON_RANK[reason] > REASON_RANK[existing.reason]) {
      await this.prisma.emailSuppression.update({
        where: { email: normalized },
        data: { reason, source },
      });
    }
  }

  /** Opting back in clears only the marketing opt-out, never a provider block. */
  async clearUnsubscribe(email: string): Promise<void> {
    const normalized = normalizeEmail(email);
    if (!normalized) return;
    await this.prisma.emailSuppression.deleteMany({
      where: { email: normalized, reason: 'UNSUBSCRIBED' },
    });
  }
}
