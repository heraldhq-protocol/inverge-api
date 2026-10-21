import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { ApiExceptionFilter, describeException } from './api-exception.filter';
import { resolveRequestId } from './request-id';

const VALID_ID = '6f1a1c1e-6f7a-4a3b-8c2d-1e2f3a4b5c6d';

describe('describeException', () => {
  // #given a ValidationPipe rejection
  // #when it is described
  // #then the messages become structured details
  it('turns a validation message array into details', () => {
    const described = describeException(
      new BadRequestException({
        message: ['take must not be greater than 100', 'mine must be a boolean'],
        error: 'Bad Request',
        statusCode: 400,
      }),
    );

    expect(described.status).toBe(400);
    expect(described.code).toBe('BAD_REQUEST');
    expect(described.message).toBe('Request validation failed.');
    expect(described.details).toEqual([
      { code: 'VALIDATION', message: 'take must not be greater than 100' },
      { code: 'VALIDATION', message: 'mine must be a boolean' },
    ]);
  });

  // #given a domain exception carrying campaign blockers
  // #when it is described
  // #then the blockers survive under details
  it('preserves domain context under details', () => {
    const described = describeException(
      new BadRequestException({ message: 'Campaign cannot be submitted', blockers: ['Identity verification'] }),
    );

    expect(described.message).toBe('Campaign cannot be submitted');
    expect(described.details).toEqual({ blockers: ['Identity verification'] });
  });

  // #given an explicit machine code
  // #when it is described
  // #then the code is kept instead of the status fallback
  it('honours an explicit error code', () => {
    const described = describeException(
      new HttpException({ message: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' }, 404),
    );

    expect(described.code).toBe('CAMPAIGN_NOT_FOUND');
    expect(described.status).toBe(404);
  });

  // #given an unexpected failure
  // #when it is described
  // #then no internal text is exposed
  it('hides unexpected errors behind a generic 500', () => {
    const described = describeException(new Error('connection string leaked'));

    expect(described.status).toBe(500);
    expect(described.code).toBe('INTERNAL_ERROR');
    expect(described.message).toBe('Internal server error.');
  });

  // #given Prisma unique and missing-record errors
  // #when they are described
  // #then they map to 409 and 404
  it('maps known Prisma errors to client-safe codes', () => {
    expect(
      describeException({ name: 'PrismaClientKnownRequestError', code: 'P2002' }).status,
    ).toBe(409);
    expect(
      describeException({ name: 'PrismaClientKnownRequestError', code: 'P2025' }).code,
    ).toBe('NOT_FOUND');
  });

  // #given an unauthenticated and a forbidden exception
  // #when they are described
  // #then they keep their status-specific codes
  it('maps auth statuses to stable codes', () => {
    expect(describeException(new ForbiddenException()).code).toBe('FORBIDDEN');
    expect(describeException(new NotFoundException()).code).toBe('NOT_FOUND');
    expect(describeException(new ServiceUnavailableException()).code).toBe(
      'SERVICE_UNAVAILABLE',
    );
  });
});

describe('ApiExceptionFilter', () => {
  function host(overrides: { requestId?: string } = {}) {
    const response = {
      headersSent: false,
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const request = {
      method: 'GET',
      originalUrl: '/api/v1/ideas/missing',
      ...overrides,
    };
    return {
      response,
      request,
      argumentsHost: {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => response,
        }),
      } as unknown as ArgumentsHost,
    };
  }

  // #given a request that already carries a correlation id
  // #when the filter writes a response
  // #then the envelope reuses it and no new header is set
  it('writes the envelope with the existing request id', () => {
    const { argumentsHost, response } = host({ requestId: VALID_ID });
    new ApiExceptionFilter().catch(new NotFoundException('Idea not found'), argumentsHost);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: 'NOT_FOUND',
        message: 'Idea not found',
        requestId: VALID_ID,
      },
    });
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  // #given a request without an id (e.g. an error thrown before middleware)
  // #when the filter writes a response
  // #then it still returns a correlation id and sets the header
  it('generates a request id when the request has none', () => {
    const { argumentsHost, response } = host();
    new ApiExceptionFilter().catch(new NotFoundException(), argumentsHost);

    const [header, value] = response.setHeader.mock.calls[0];
    expect(header).toBe('x-request-id');
    expect(value).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.json.mock.calls[0][0].error.requestId).toBe(value);
  });
});

describe('resolveRequestId', () => {
  // #given a valid inbound UUID
  // #when it is resolved
  // #then it is reused so a caller can correlate its own trace
  it('keeps a valid uuid', () => {
    expect(resolveRequestId(VALID_ID)).toBe(VALID_ID);
  });

  // #given anything that is not a UUID
  // #when it is resolved
  // #then a fresh id is generated instead
  it('rejects arbitrary header values', () => {
    expect(resolveRequestId('../../etc/passwd')).not.toBe('../../etc/passwd');
    expect(resolveRequestId(['not-a-uuid'])).not.toBe('not-a-uuid');
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
