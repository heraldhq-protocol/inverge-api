import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Correlation id for one API request (NFR-20).
 *
 * The header is echoed on every response and copied into the error envelope so a
 * client can quote one value when reporting a failure. An inbound value is only
 * trusted when it is a UUID: accepting arbitrary strings would let a caller forge
 * log lines or grow the header without bound.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveRequestId(inbound: unknown): string {
  const value = Array.isArray(inbound) ? inbound[0] : inbound;
  return typeof value === 'string' && UUID_PATTERN.test(value)
    ? value
    : randomUUID();
}

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}
