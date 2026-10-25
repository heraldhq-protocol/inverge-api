import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { API_PREFIX } from '../src/openapi';

/**
 * The path prefix is part of the public contract, so it is asserted rather than
 * assumed. The other e2e suites mount the module without a prefix and exercise
 * handlers directly; this suite is the one that proves production routing.
 */
describe('API version prefix', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves a route under /api/v1', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/check-username?username=ab')
      .expect(200);

    expect(response.body.available).toBe(false);
  });

  it('does not serve the unversioned path', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/check-username?username=ab')
      .expect(404);

    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.requestId).toEqual(expect.any(String));
    expect(response.headers['x-request-id']).toBe(response.body.error.requestId);
  });
});
