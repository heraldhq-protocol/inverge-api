import { Module } from '@nestjs/common';
import { WebhookInboxModule } from '../../common/webhooks/webhook-inbox.module';
import { FlatFeeController } from './flat-fee.controller';
import { FlatFeeService } from './flat-fee.service';

@Module({
  imports: [WebhookInboxModule],
  controllers: [FlatFeeController],
  providers: [FlatFeeService],
  exports: [FlatFeeService],
})
export class FlatFeeModule {}
