import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';

/**
 * Kill switch for the analytics read surface. Ingestion is controlled separately
 * by `ANALYTICS_INGEST_ENABLED`; an operator can stop serving reports without
 * redeploying or disabling the nightly roll-ups.
 *
 * A disabled surface returns 404 rather than 403 so it is indistinguishable from
 * a route that does not exist.
 */
@Injectable()
export class AnalyticsReadGuard implements CanActivate {
  private readonly enabled: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.enabled = config.get('ANALYTICS_READ_ENABLED', { infer: true });
  }

  canActivate(): boolean {
    if (!this.enabled) throw new NotFoundException();
    return true;
  }
}
