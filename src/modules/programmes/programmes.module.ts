import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminProgrammesController } from './admin-programmes.controller';
import { AdminProgrammesService } from './admin-programmes.service';
import { ProgrammeJudgeController } from './programme-judge.controller';
import { ProgrammeJudgingService } from './programme-judging.service';
import { ProgrammeResultsService } from './programme-results.service';
import { ProgrammesController } from './programmes.controller';
import { ProgrammesService } from './programmes.service';

@Module({
  imports: [forwardRef(() => AuthModule), NotificationsModule],
  controllers: [
    ProgrammesController,
    ProgrammeJudgeController,
    AdminProgrammesController,
  ],
  providers: [
    ProgrammesService,
    ProgrammeJudgingService,
    ProgrammeResultsService,
    AdminProgrammesService,
  ],
  exports: [ProgrammesService, ProgrammeResultsService],
})
export class ProgrammesModule {}
