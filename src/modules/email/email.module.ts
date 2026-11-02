import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebhookInboxModule } from '../../common/webhooks/webhook-inbox.module';
import { AdminEmailController } from './admin-email.controller';
import { EditorialEmailService } from './editorial-email.service';
import { EmailDeliveryModule } from './email-delivery.module';
import {
  EmailPreferencesController,
  MeEmailController,
} from './email-preferences.controller';
import { EmailPreferencesService } from './email-preferences.service';
import { EmailWebhookController } from './email-webhook.controller';
import { EmailWebhookService } from './email-webhook.service';

/**
 * Shared email system: branded templates, delivery ledger, suppression,
 * editorial consent and provider webhooks. The provider itself is bound through
 * `EMAIL_PORT` (PortsModule), so swapping vendors never touches this module.
 */
@Module({
  imports: [AuthModule, EmailDeliveryModule, WebhookInboxModule],
  controllers: [
    AdminEmailController,
    EmailPreferencesController,
    MeEmailController,
    EmailWebhookController,
  ],
  providers: [
    EmailPreferencesService,
    EditorialEmailService,
    EmailWebhookService,
  ],
  exports: [EmailDeliveryModule],
})
export class EmailModule {}
