import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { Env } from './config/env.validation';
import { requestIdMiddleware } from './common/http/request-id';
import { API_PREFIX, createOpenApiDocument } from './openapi';

import { json, urlencoded } from 'express';

async function bootstrap() {
  // rawBody: true exposes req.rawBody for webhook signature verification (flat-fee, kyc).
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.setGlobalPrefix(API_PREFIX);
  app.use(requestIdMiddleware);
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ limit: '10mb', extended: true }));
  app.use(helmet());
  app.enableCors();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks(); // graceful shutdown -> PrismaService.$disconnect

  SwaggerModule.setup('docs', app, createOpenApiDocument(app));

  const config = app.get(ConfigService) as ConfigService<Env, true>;
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  console.log(
    `Inverge API on http://localhost:${port}/${API_PREFIX} (OpenAPI docs at /docs)`,
  );
}

void bootstrap();
