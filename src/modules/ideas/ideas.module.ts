import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MetricsModule } from '../metrics/metrics.module';
import { QualityModule } from '../quality/quality.module';
import { IdeasController } from './ideas.controller';
import { IdeasService } from './ideas.service';

@Module({
  imports: [AuthModule, MetricsModule, QualityModule],
  controllers: [IdeasController],
  providers: [IdeasService],
  exports: [IdeasService],
})
export class IdeasModule {}
