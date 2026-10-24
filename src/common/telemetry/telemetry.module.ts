import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CacheModule } from '../cache/cache.module';
import { HealthController } from '../../modules/health/health.controller';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { MetricsController } from './metrics.controller';
import { RequestLogInterceptor } from './request-log.interceptor';
import { TelemetryService } from './telemetry.service';

@Global()
@Module({
  imports: [CacheModule],
  controllers: [HealthController, MetricsController],
  providers: [
    TelemetryService,
    // Metrics first (outermost) so a request rejected by the rate limiter is
    // still counted; the log line is written inside it.
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: RequestLogInterceptor },
  ],
  exports: [TelemetryService],
})
export class TelemetryModule {}
