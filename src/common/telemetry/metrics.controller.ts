import {
  Controller,
  Get,
  Header,
  Headers,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import { Env } from '../../config/env.validation';
import { CacheService } from '../../common/cache/cache.service';
import { TelemetryService } from '../../common/telemetry/telemetry.service';

/**
 * Prometheus scrape endpoint. Kept at the root (not under `/api/v1`) because it
 * is infrastructure, and hidden from the public OpenAPI document. When
 * `METRICS_TOKEN` is set the caller must present it as a bearer token.
 */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  private readonly enabled: boolean;
  private readonly token?: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly telemetry: TelemetryService,
    private readonly cache: CacheService,
  ) {
    this.enabled = config.get('METRICS_ENABLED', { infer: true });
    this.token = config.get('METRICS_TOKEN', { infer: true }) || undefined;
  }

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(@Headers('authorization') authorization?: string) {
    if (!this.enabled) throw new NotFoundException('Not found');

    if (this.token) {
      const provided = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : '';
      const expected = Buffer.from(this.token);
      const actual = Buffer.from(provided);
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      ) {
        throw new UnauthorizedException({
          code: 'UNAUTHENTICATED',
          message: 'Metrics token required.',
        });
      }
    }

    const stats = this.cache.stats();
    const cacheLines = [
      '# TYPE cache_operations_total counter',
      `cache_operations_total{result="hit"} ${stats.hits}`,
      `cache_operations_total{result="miss"} ${stats.misses}`,
      `cache_operations_total{result="coalesced"} ${stats.coalesced}`,
      `cache_operations_total{result="read_error"} ${stats.readErrors}`,
      '# TYPE cache_writes_total counter',
      `cache_writes_total ${stats.sets}`,
    ];

    return `${this.telemetry.render()}${cacheLines.join('\n')}\n`;
  }
}
