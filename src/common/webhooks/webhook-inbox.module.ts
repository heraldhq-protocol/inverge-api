import { Module } from '@nestjs/common';
import { WebhookInboxService } from './webhook-inbox.service';

@Module({
  providers: [WebhookInboxService],
  exports: [WebhookInboxService],
})
export class WebhookInboxModule {}
