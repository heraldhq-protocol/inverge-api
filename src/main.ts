import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { Env } from './config/env.validation';
import { API_PREFIX, createOpenApiDocument } from './openapi';

async function bootstrap() {
  // rawBody: true exposes req.rawBody for webhook signature verification (flat-fee, kyc).
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);

  // Docs are not mounted by the e2e harness; only the real server exposes them.
  SwaggerModule.setup('docs', app, createOpenApiDocument(app));

  const config = app.get(ConfigService) as ConfigService<Env, true>;
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  console.log(
    `Inverge API on http://localhost:${port}/${API_PREFIX} (OpenAPI docs at /docs)`,
  );
}

void bootstrap();
