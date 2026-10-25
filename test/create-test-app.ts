import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';

/**
 * One e2e bootstrap for every suite.
 *
 * It applies the same global prefix, body limits, CORS, validation pipe and
 * proxy trust as `main.ts`. Suites previously mounted an un-prefixed app with
 * only the pipe, so they could pass while production routing was broken.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.init();
  return app;
}
