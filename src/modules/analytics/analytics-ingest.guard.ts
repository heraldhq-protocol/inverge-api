import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Env } from '../../config/env.validation';

const TIMESTAMP_HEADER = 'x-inverge-timestamp';
const SIGNATURE_HEADER = 'x-inverge-signature';

type RawBodyRequest = Request & { rawBody?: Buffer };

function constantTimeEqual(expected: string, provided: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(provided, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * HMAC guard for the service-to-service ingest route.
 *
 * The caller signs `${timestamp}.${rawBody}` with a shared secret. The raw body is
 * used so the signature covers the exact bytes that were sent, not a re-serialised
 * object whose key order may differ. Nothing from the request is logged.
 */
@Injectable()
export class AnalyticsIngestGuard implements CanActivate {
  private readonly enabled: boolean;
  private readonly secret?: string;
  private readonly skewSeconds: number;
  private readonly maxBodyBytes: number;

  constructor(config: ConfigService<Env, true>) {
    this.enabled = config.get('ANALYTICS_INGEST_ENABLED', { infer: true });
    this.secret = config.get('ANALYTICS_INGEST_SECRET', { infer: true });
    this.skewSeconds = config.get('ANALYTICS_INGEST_CLOCK_SKEW_SECONDS', {
      infer: true,
    });
    this.maxBodyBytes = config.get('ANALYTICS_INGEST_MAX_BODY_BYTES', {
      infer: true,
    });
  }

  canActivate(context: ExecutionContext): boolean {
    // A disabled route is hidden, not merely forbidden.
    if (!this.enabled) throw new NotFoundException();

    if (!this.secret) {
      throw new ServiceUnavailableException({
        code: 'ANALYTICS_INGEST_UNAVAILABLE',
        message: 'Analytics ingest is not configured',
      });
    }

    const request = context.switchToHttp().getRequest<RawBodyRequest>();
    const rawBody = request.rawBody;
    if (!rawBody || rawBody.length === 0) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Analytics ingest requires a signed body',
      });
    }
    if (rawBody.length > this.maxBodyBytes) {
      throw new PayloadTooLargeException({
        code: 'ANALYTICS_BATCH_TOO_LARGE',
        message: 'Analytics batch body is too large',
      });
    }

    const timestamp = request.header(TIMESTAMP_HEADER);
    const signature = request.header(SIGNATURE_HEADER);
    if (!timestamp || !signature) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Analytics ingest requires a timestamp and signature',
      });
    }

    const seconds = Number(timestamp);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      !Number.isInteger(seconds) ||
      Math.abs(nowSeconds - seconds) > this.skewSeconds
    ) {
      throw new UnauthorizedException({
        code: 'STALE_ANALYTICS_SIGNATURE',
        message: 'Analytics ingest signature has expired',
      });
    }

    const expected = createHmac('sha256', this.secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
    const provided = signature.startsWith('sha256=')
      ? signature.slice('sha256='.length)
      : signature;

    if (!constantTimeEqual(expected, provided)) {
      throw new UnauthorizedException({
        code: 'INVALID_ANALYTICS_SIGNATURE',
        message: 'Analytics ingest signature is invalid',
      });
    }

    return true;
  }
}
