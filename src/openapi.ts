import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/**
 * The versioned base path every route is served under.
 *
 * Set on the Nest application (`setGlobalPrefix`) and mirrored in the committed
 * OpenAPI document, so the generated client and the running server agree.
 */
export const API_PREFIX = 'api/v1';

export const API_VERSION = '1.0.0';

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Inverge API')
    .setDescription(
      'Milestone-escrowed crowdfunding and idea validation for African builders. ' +
        'Escrow balances and settlement are owned by the Solana program; this API serves ' +
        'off-chain content and indexed projections.',
    )
    .setVersion(API_VERSION)
    .addBearerAuth()
    .build();

  return SwaggerModule.createDocument(app, config);
}
