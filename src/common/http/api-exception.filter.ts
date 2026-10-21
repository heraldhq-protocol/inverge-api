import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { REQUEST_ID_HEADER } from './request-id';

/**
 * One error shape for the whole API.
 *
 * Every failure is `{ error: { code, message, requestId, details? } }`. `code` is
 * the stable part a client may branch on; `message` is human text and may change.
 * Internal failures never echo an exception message or a provider payload (NFR-09).
 */
export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
};

const STATUS_CODE: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

const EXPLICIT_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const PRISMA_KNOWN_ERROR = 'PrismaClientKnownRequestError';

type DescribedError = {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  /** Set only for 5xx: the text logged with the stack. */
  cause?: unknown;
};

function explicitCode(value: unknown): string | undefined {
  return typeof value === 'string' && EXPLICIT_CODE.test(value) ? value : undefined;
}

function describeHttpException(exception: HttpException): DescribedError {
  const status = exception.getStatus();
  const body = exception.getResponse();

  if (typeof body === 'string') {
    return {
      status,
      code: STATUS_CODE[status] ?? 'HTTP_ERROR',
      message: body,
    };
  }

  if (!body || typeof body !== 'object') {
    return { status, code: STATUS_CODE[status] ?? 'HTTP_ERROR', message: exception.message };
  }

  const record = body as Record<string, unknown>;
  const rawMessage = record.message;
  const code = explicitCode(record.code) ?? STATUS_CODE[status] ?? 'HTTP_ERROR';

  // ValidationPipe returns `message: string[]`; each entry is one failed rule.
  if (Array.isArray(rawMessage)) {
    return {
      status,
      code,
      message: 'Request validation failed.',
      details: rawMessage.map((message) => ({
        code: 'VALIDATION',
        message: String(message),
      })),
    };
  }

  // Domain exceptions may attach structured context (for example campaign
  // eligibility `blockers`). Anything other than the envelope's own keys is
  // preserved under `details` so it is not silently dropped.
  const reserved = new Set(['statusCode', 'error', 'message', 'code']);
  const extra = Object.fromEntries(
    Object.entries(record).filter(([key]) => !reserved.has(key)),
  );

  return {
    status,
    code,
    message:
      typeof rawMessage === 'string' && rawMessage.length > 0
        ? rawMessage
        : exception.message,
    details: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

function describePrismaError(exception: { code: string; meta?: unknown }): DescribedError {
  switch (exception.code) {
    case 'P2002':
      return { status: 409, code: 'CONFLICT', message: 'That value is already in use.' };
    case 'P2025':
      return { status: 404, code: 'NOT_FOUND', message: 'Resource not found.' };
    case 'P2003':
      return {
        status: 409,
        code: 'CONFLICT',
        message: 'The request references a record that does not exist.',
      };
    default:
      return {
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        cause: exception,
      };
  }
}

export function describeException(exception: unknown): DescribedError {
  if (exception instanceof HttpException) return describeHttpException(exception);

  if (
    exception !== null &&
    typeof exception === 'object' &&
    (exception as { name?: unknown }).name === PRISMA_KNOWN_ERROR &&
    typeof (exception as { code?: unknown }).code === 'string'
  ) {
    return describePrismaError(exception as { code: string });
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL_ERROR',
    message: 'Internal server error.',
    cause: exception,
  };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const described = describeException(exception);

    const requestId = request.requestId ?? randomUUID();
    if (!request.requestId) {
      request.requestId = requestId;
      response.setHeader(REQUEST_ID_HEADER, requestId);
    }

    if (described.status >= 500) {
      // `path` excludes the query string: a 500 must not copy search terms or
      // provider callback parameters into the log.
      this.logger.error(
        `${request.method ?? 'UNKNOWN'} ${request.path ?? ''} -> ${described.status} [${requestId}]`,
        described.cause instanceof Error ? described.cause.stack : undefined,
      );
    }

    const body: ApiErrorBody = {
      error: {
        code: described.code,
        message: described.message,
        requestId,
        ...(described.details === undefined ? {} : { details: described.details }),
      },
    };

    if (response.headersSent) return;
    response.status(described.status).json(body);
  }
}
