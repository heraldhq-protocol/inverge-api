import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Observable, finalize, tap } from 'rxjs';
import { Env } from '../../config/env.validation';
import { hashIdentifier } from './hash-identifier';

function statusOfError(error: unknown): number {
  if (error instanceof HttpException) return error.getStatus();
  return 500;
}

/**
 * One line per HTTP request (architecture plan §4.6): correlation id, route,
 * status, duration and a hashed user id. No query string, body, token, cookie or
 * raw IP is logged. In JSON mode the line is emitted by `JsonLogger`; otherwise
 * it is a compact human-readable line.
 */
@Injectable()
export class RequestLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');
  private readonly json: boolean;
  private readonly salt: string;

  constructor(config: ConfigService<Env, true>) {
    const format =
      config.get('LOG_FORMAT', { infer: true }) ??
      (config.get('NODE_ENV', { infer: true }) === 'production' ? 'json' : 'pretty');
    this.json = format === 'json';
    this.salt = config.get('LOG_HASH_SALT', { infer: true });
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
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
        const durationMs = Math.round(
          Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        );
        const status = errorStatus ?? response.statusCode;
        const route =
          (request.route as { path?: unknown } | undefined)?.path ?? 'unmatched';

        if (this.json) {
          this.logger.log({
            event: 'http_request',
            requestId: request.requestId,
            method: request.method,
            route: typeof route === 'string' ? route : 'unmatched',
            status,
            durationMs,
            userId: hashIdentifier(
              (request as Request & { user?: { id?: string } }).user?.id,
              this.salt,
            ),
          });
          return;
        }

        this.logger.log(
          `${request.method} ${typeof route === 'string' ? route : request.path} -> ${status} ${durationMs}ms`,
        );
      }),
    );
  }
}
