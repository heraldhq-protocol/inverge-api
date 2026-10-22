import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../common/cache/redis.service';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('probe timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Liveness and readiness (architecture plan §4.6).
 *
 * Liveness only proves the event loop is serving. Readiness proves the one hard
 * dependency (Postgres). Redis is reported but does not fail readiness: the API
 * degrades to Postgres when Redis is down, and taking every replica out of the
 * load balancer for an optional cache would turn a performance incident into an
 * outage.
 */
@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('live')
  live() {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  @Get('ready')
  async ready() {
    let database: 'up' | 'down' = 'up';
    try {
      await withTimeout(this.prisma.$queryRawUnsafe('SELECT 1'), 1_000);
    } catch {
      database = 'down';
    }

    const redisStatus = this.redis.status();
    const redis = !redisStatus.enabled
      ? 'disabled'
      : (await this.redis.ping())
        ? 'up'
        : 'down';

    const body = {
      status:
        database === 'down' ? 'unavailable' : redis === 'down' ? 'degraded' : 'ok',
      checks: { database, redis },
      checkedAt: new Date().toISOString(),
    };

    if (database === 'down') {
      throw new ServiceUnavailableException({
        code: 'NOT_READY',
        message: 'Database is unavailable.',
        details: body,
      });
    }

    return body;
  }
}
