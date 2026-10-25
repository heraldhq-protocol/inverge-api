import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { Env } from '../../config/env.validation';
import { TelemetryService } from '../telemetry/telemetry.service';
import { RATE_LIMIT_KEY } from './rate-limit.decorator';
import {
  RATE_LIMIT_POLICIES,
  RateLimitPolicyName,
  resolveRateLimitPolicy,
} from './rate-limit.policies';
import { RateLimitService } from './rate-limit.service';

/**
 * Token-bucket enforcement (architecture plan §7.2).
 *
 * Runs after guards (it is an interceptor), so a user-scoped policy can key on
 * the authenticated id instead of an IP shared by a household or an office.
 * Headers describe the policy that actually ran; they are not a global quota.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private readonly enabled: boolean;

  constructor(
    config: ConfigService<Env, true>,
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
    private readonly telemetry: TelemetryService,
  ) {
    this.enabled = config.get('RATE_LIMIT_ENABLED', { infer: true });
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (!this.enabled) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const policyName =
      this.reflector.getAllAndOverride<RateLimitPolicyName>(RATE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? resolveRateLimitPolicy(request);

    if (!policyName) return next.handle();

    const policy = RATE_LIMIT_POLICIES[policyName];
    const user = (request as Request & { user?: { id?: string } }).user;
    const identifier =
      policy.scope === 'user' && user?.id
        ? `user:${user.id}`
        : `ip:${request.ip ?? 'unknown'}`;

    const decision = await this.limiter.consume(
      this.limiter.keyFor(policyName, identifier),
      policy,
    );

    response.setHeader('RateLimit-Limit', policy.burst);
    response.setHeader('RateLimit-Remaining', decision.remaining);
    response.setHeader(
      'RateLimit-Reset',
      decision.retryAfterSeconds || policy.windowSeconds,
    );

    if (decision.source === 'unavailable') {
      this.telemetry.inc('rate_limit_rejections_total', {
        policy: policyName,
        reason: 'unavailable',
      });
      response.setHeader('Retry-After', '1');
      throw new ServiceUnavailableException({
        code: 'RATE_LIMIT_UNAVAILABLE',
        message: 'Request protection is temporarily unavailable. Retry shortly.',
      });
    }

    if (!decision.allowed) {
      this.telemetry.inc('rate_limit_rejections_total', {
        policy: policyName,
        reason: 'limited',
      });
      response.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw new HttpException(
        {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many requests.',
          details: {
            policy: policyName,
            retryAfterSeconds: decision.retryAfterSeconds,
          },
        },
        429,
      );
    }

    return next.handle();
  }
}
