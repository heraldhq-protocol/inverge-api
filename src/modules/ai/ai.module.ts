import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IdeasModule } from '../ideas/ideas.module';
import { AiEntitlementService } from './ai-entitlement.service';
import { AiUsageService } from './ai-usage.service';
import { AiService } from './ai.service';
import {
  AdminAiController,
  AiController,
  IdeaAssistantController,
} from './ai.controller';

@Module({
  imports: [AuthModule, IdeasModule],
  controllers: [AiController, IdeaAssistantController, AdminAiController],
  providers: [AiEntitlementService, AiUsageService, AiService],
  exports: [AiEntitlementService, AiUsageService],
})
export class AiModule {}
