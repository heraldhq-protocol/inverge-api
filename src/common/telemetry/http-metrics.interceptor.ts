import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Observable, finalize, tap } from 'rxjs';
import { Env } from '../../config/env.validation';
import { TelemetryService } from './telemetry.service';

function statusOfError(error: unknown): number {
  if (error instanceof HttpException) return error.getStatus();
  return 500;
}

/**
 * Route labels stay low-cardinality: the matched Express pattern (`/ideas/:id`),
 * never the concrete path. Metrics must not grow a series per idea id.
 */
function routeLabel(request: Request): string {
  const route = request.route as { path?: unknown } | undefined;
  return typeof route?.path === 'string' ? route.path : 'unmatched';
}

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  private readonly enabled: boolean;

  constructor(
    private readonly telemetry: TelemetryService,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('METRICS_ENABLED', { infer: true });
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.enabled) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const startedAt = process.hrtime.bigint();
    let errorStatus: number | undefined;

    return next.handle().pipe(
      tap({
        error: (error: unknown) => {
          errorStatus = statusOfError(error);
        },
      }),
      finalize(() => {
        const durationSeconds =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        const status = errorStatus ?? response.statusCode;
        const labels = {
          method: request.method,
          route: routeLabel(request),
          status: String(status),
        };

        this.telemetry.inc('http_requests_total', labels);
        this.telemetry.observe('http_request_duration_seconds', durationSeconds, {
          method: request.method,
          route: labels.route,
        });
      }),
    );
  }
}
