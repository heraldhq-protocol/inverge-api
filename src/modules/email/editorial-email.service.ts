import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import {
  EMAIL_TEMPLATES,
  EmailTemplateId,
  TemplateVariables,
  isEmailTemplateId,
  renderEmailTemplate,
} from '../../common/email';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailContextService } from './email-context.service';
import { EmailDeliveryService } from './email-delivery.service';

const MAX_RECIPIENTS = 50;

export interface EditorialSendResult {
  sent: number;
  suppressed: number;
  duplicate: number;
  exhausted: number;
  failed: number;
}

/**
 * Manual editorial sending only. There is no scheduler and no audience builder:
 * the caller names explicit accounts, and every recipient must already hold an
 * active editorial subscription. Turning this on is an explicit deployment
 * decision (`EDITORIAL_EMAILS_ENABLED`), because content source, selection and
 * cadence are editorial decisions this service must not invent.
 */
@Injectable()
export class EditorialEmailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly context: EmailContextService,
    private readonly delivery: EmailDeliveryService,
  ) {}

  preview(templateId: string, variables: TemplateVariables) {
    const definition = this.marketingTemplate(templateId);
    const rendered = renderEmailTemplate(definition.id, variables, {
      ...this.context.renderOptions(),
      // A preview link is intentionally inert; it is not a real subscription id.
      unsubscribeUrl: `${this.context.apiUrl()}/api/v1/email/preferences/preview`,
    });
    return {
      category: definition.category,
      html: rendered.html,
      subject: rendered.subject,
      text: rendered.text,
    };
  }

  async send(
    templateId: string,
    variables: TemplateVariables,
    issueId: string,
    userIds: string[],
  ): Promise<EditorialSendResult> {
    if (!this.config.get('EDITORIAL_EMAILS_ENABLED', { infer: true })) {
      throw new ForbiddenException({
        code: 'EDITORIAL_EMAILS_DISABLED',
        message:
          'Editorial sending is disabled. Configure the sender, consent and content process before enabling it.',
      });
    }
    this.marketingTemplate(templateId);

    const unique = [...new Set(userIds)];
    if (unique.length === 0) {
      throw new BadRequestException('At least one recipient is required');
    }
    if (unique.length > MAX_RECIPIENTS) {
      throw new BadRequestException(
        `A single editorial send accepts at most ${MAX_RECIPIENTS} recipients`,
      );
    }

    const recipients = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, email: true },
    });
    const result: EditorialSendResult = {
      duplicate: 0,
      exhausted: 0,
      failed: 0,
      sent: 0,
      suppressed: 0,
    };

    for (const user of recipients) {
      if (!user.email) {
        result.suppressed += 1;
        continue;
      }
      try {
        const outcome = await this.delivery.deliver({
          idempotencyKey: `editorial:${issueId}:${templateId}:${user.id}`,
          templateId: templateId as EmailTemplateId,
          to: user.email,
          userId: user.id,
          variables,
        });
        if (outcome.status === 'sent') result.sent += 1;
        else if (outcome.status === 'suppressed') result.suppressed += 1;
        else if (outcome.status === 'exhausted') result.exhausted += 1;
        else result.duplicate += 1;
      } catch {
        // The delivery row records the provider error. The batch continues so
        // one bad recipient cannot block the rest.
        result.failed += 1;
      }
    }

    return result;
  }

  private marketingTemplate(templateId: string) {
    if (!isEmailTemplateId(templateId)) {
      throw new BadRequestException('Unknown email template');
    }
    const definition = EMAIL_TEMPLATES[templateId];
    if (definition.category !== 'marketing') {
      throw new BadRequestException(
        'Only editorial templates can be sent through the editorial route',
      );
    }
    return definition;
  }
}
