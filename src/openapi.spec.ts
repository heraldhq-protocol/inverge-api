import type { OpenAPIObject } from '@nestjs/swagger';
import { attachErrorEnvelope } from './openapi';

function baseDocument(): OpenAPIObject {
  return {
    openapi: '3.0.0',
    info: { title: 'test', version: '1.0.0' },
    paths: {
      '/ideas': {
        get: { responses: { '200': { description: 'ok' } } },
        post: { responses: {} },
      },
      '/health': {
        get: { responses: { default: { description: 'custom' } } },
      },
      '/empty': {},
    },
  };
}

function operationAt(
  document: OpenAPIObject,
  path: string,
  method: string,
): Record<string, unknown> {
  const pathItem = document.paths[path] as unknown as Record<string, unknown>;
  return pathItem[method] as Record<string, unknown>;
}

function responsesAt(
  document: OpenAPIObject,
  path: string,
  method: string,
): Record<string, unknown> {
  return operationAt(document, path, method).responses as Record<string, unknown>;
}

describe('attachErrorEnvelope', () => {
  it('adds the shared error schema and a default response to every operation', () => {
    // given
    const document = baseDocument();

    // when
    const result = attachErrorEnvelope(document);

    // then
    expect(result.components?.schemas?.ErrorResponse).toMatchObject({
      type: 'object',
      required: ['error'],
    });
    expect(responsesAt(result, '/ideas', 'get').default).toBeDefined();
    expect(responsesAt(result, '/ideas', 'post').default).toBeDefined();
  });

  it('keeps a default response a handler already declared', () => {
    // given
    const document = baseDocument();

    // when
    const result = attachErrorEnvelope(document);

    // then
    expect(responsesAt(result, '/health', 'get').default).toEqual({
      description: 'custom',
    });
  });

  it('leaves a path with no operations untouched', () => {
    // given
    const document = baseDocument();

    // when
    const result = attachErrorEnvelope(document);

    // then
    expect(result.paths['/empty']).toEqual({});
  });

  it('produces the same document on repeated runs', () => {
    // given
    const first = attachErrorEnvelope(baseDocument());

    // when
    const second = attachErrorEnvelope(baseDocument());

    // then
    expect(second).toEqual(first);
  });
});
