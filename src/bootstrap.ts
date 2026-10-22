import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { Env } from './config/env.validation';
import { requestIdMiddleware } from './common/http/request-id';
import { JsonLogger } from './common/telemetry/json-logger';
import { API_PREFIX } from './openapi';

/**
 * Routes that live outside the versioned prefix. They are consumed by the
 * orchestrator and the scrape layer, not by product clients, and must keep
 * stable paths across API versions.
 */
const OUTSIDE_API_PREFIX = [
  { path: 'health/live', method: RequestMethod.GET },
  { path: 'health/ready', method: RequestMethod.GET },
  { path: 'metrics', method: RequestMethod.GET },
];

/**
 * Application wiring shared by `main.ts` and the e2e harness. Keeping it in one
 * place is what makes e2e exercise the same prefix, pipes, proxy trust and CORS
 * as production; previously each suite mounted its own un-prefixed app.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService) as ConfigService<Env, true>;

  app.setGlobalPrefix(API_PREFIX, { exclude: OUTSIDE_API_PREFIX });

  // Correlation id first so every later log line and error body has one.
  app.use(requestIdMiddleware);

  app.use(json({ limit: config.get('JSON_BODY_LIMIT', { infer: true }) }));
  app.use(
    urlencoded({
      limit: config.get('JSON_BODY_LIMIT', { infer: true }),
      extended: true,
    }),
  );
  app.use(helmet());

  const configuredOrigins = config
    .get('CORS_ORIGINS', { infer: true })
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const developmentOrigins =
    config.get('NODE_ENV', { infer: true }) === 'production'
      ? []
      : ['http://localhost:3000', 'http://localhost:3001'];

  const origins = configuredOrigins.length > 0 ? configuredOrigins : developmentOrigins;

  app.enableCors({
    // No configured origin in production means same-origin only: the web app
    // reaches the API through its own server, so a wildcard is never needed.
    origin: origins.length > 0 ? origins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Request-Id',
      'traceparent',
      'x-paystack-signature',
      'x-didit-signature',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
    ],
    maxAge: 600,
  });

  const hops = config.get('TRUST_PROXY_HOPS', { infer: true });
  if (hops > 0) {
    // Only the resolved req.ip is trusted for rate-limit keys; a raw
    // X-Forwarded-For header never is.
    (
      app.getHttpAdapter().getInstance() as { set: (key: string, value: unknown) => void }
    ).set('trust proxy', hops);
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Query and body fields opt into conversion explicitly with @Type so a
      // string never silently becomes a number or boolean.
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const format =
    config.get('LOG_FORMAT', { infer: true }) ??
    (config.get('NODE_ENV', { infer: true }) === 'production' ? 'json' : 'pretty');
  if (format === 'json') {
    app.useLogger(new JsonLogger(config.get('LOG_LEVEL', { infer: true })));
  }

  app.enableShutdownHooks();
}
