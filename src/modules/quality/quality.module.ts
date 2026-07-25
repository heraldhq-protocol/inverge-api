import { Module } from '@nestjs/common';
import { QualityService } from './quality.service';

// QUALITY_SCORER_PORT comes from the @Global PortsModule; PrismaService and
// PlatformParamsService are also global.
@Module({
  providers: [QualityService],
  exports: [QualityService],
})
export class QualityModule {}
