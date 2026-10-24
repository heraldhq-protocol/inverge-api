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

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

const ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: {
          type: 'string',
          description: 'Stable `SCREAMING_SNAKE_CASE` code a client may branch on.',
          example: 'CAMPAIGN_NOT_FOUND',
        },
        message: {
          type: 'string',
          description: 'Human text. May change; do not parse it.',
        },
        requestId: {
          type: 'string',
          format: 'uuid',
          description: 'Matches the `x-request-id` response header.',
        },
        details: {
          description:
            'Optional validation entries or route-specific context. ' +
            'Shape depends on the failure; clients must narrow before use.',
        },
      },
    },
  },
};

const ERROR_RESPONSE = {
  description: 'Error envelope. Every non-2xx response uses this shape.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ErrorResponse' },
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Adds the error envelope to every operation.
 *
 * `ApiExceptionFilter` is registered globally, so every route can return this
 * shape. Declaring it as each handler's `default` response is more accurate than
 * enumerating status codes per route (and avoids a decorator on every method).
 * A handler that already declares a `default` response keeps it.
 */
export function attachErrorEnvelope(document: OpenAPIObject): OpenAPIObject {
  const components = (document.components ??= {});
  const schemas = (components.schemas ??= {});
  schemas.ErrorResponse ??= ERROR_SCHEMA;

  for (const pathItem of Object.values(document.paths ?? {})) {
    if (!isRecord(pathItem)) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;

      const responses = isRecord(operation.responses) ? operation.responses : {};
      operation.responses = responses;
      responses.default ??= ERROR_RESPONSE;
    }
  }

  return document;
}

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

  return attachErrorEnvelope(SwaggerModule.createDocument(app, config));
}
