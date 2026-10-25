import {
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { Env } from '../../config/env.validation';
import { AnalyticsIngestGuard } from './analytics-ingest.guard';

const SECRET = 'unit-analytics-ingest-secret-000000000000';
const NOW_SECONDS = 1_792_500_000;
const BODY = Buffer.from('{"events":[]}', 'utf8');

function setup(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    ANALYTICS_INGEST_ENABLED: true,
    ANALYTICS_INGEST_SECRET: SECRET,
    ANALYTICS_INGEST_CLOCK_SKEW_SECONDS: 300,
    ANALYTICS_INGEST_MAX_BODY_BYTES: 64 * 1024,
    ...overrides,
  };
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService<Env, true>;
  return new AnalyticsIngestGuard(config);
}

function context(
  rawBody: Buffer | null = BODY,
  headers: Record<string, string | undefined> = {},
) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        rawBody,
        header: (name: string) => headers[name],
      }),
    }),
  } as never;
}

function signature(
  timestamp: string,
  body: Buffer = BODY,
  secret = SECRET,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');
}

describe('AnalyticsIngestGuard', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('hides the route when ingest is disabled', () => {
    // #given ingest disabled
    // #when the guard runs
    // #then the route is a 404, not a 403
    expect(() =>
      setup({ ANALYTICS_INGEST_ENABLED: false }).canActivate(context()),
    ).toThrow(NotFoundException);
  });

  it('fails closed when enabled without a secret', () => {
    // #given ingest enabled but no secret
    // #when the guard runs
    // #then the route is unavailable rather than open
    expect(() =>
      setup({ ANALYTICS_INGEST_SECRET: undefined }).canActivate(context()),
    ).toThrow(ServiceUnavailableException);
  });

  it('rejects a request with no raw body', () => {
    // #given a body parser did not capture the bytes
    // #when the guard runs
    // #then the caller is unauthenticated
    expect(() => setup().canActivate(context(null, {}))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a body over the configured limit', () => {
    // #given a body larger than the cap
    // #when the guard runs
    // #then it is a payload error
    expect(() =>
      setup({ ANALYTICS_INGEST_MAX_BODY_BYTES: 4 }).canActivate(context()),
    ).toThrow(PayloadTooLargeException);
  });

  it('rejects a missing timestamp or signature', () => {
    // #given no signature headers
    // #when the guard runs
    // #then the caller is unauthenticated
    expect(() => setup().canActivate(context(BODY, {}))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a stale timestamp', () => {
    // #given a timestamp an hour old
    const timestamp = String(NOW_SECONDS - 3_600);
    const headers = {
      'x-inverge-timestamp': timestamp,
      'x-inverge-signature': signature(timestamp),
    };

    // #when the guard runs
    // #then it is rejected as expired
    expect(() => setup().canActivate(context(BODY, headers))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a non-integer timestamp', () => {
    // #given a timestamp that is not an integer
    const headers = {
      'x-inverge-timestamp': 'not-a-number',
      'x-inverge-signature': signature('not-a-number'),
    };

    // #when the guard runs
    // #then it is rejected as expired
    expect(() => setup().canActivate(context(BODY, headers))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a signature made with a different secret', () => {
    // #given a signature from another key
    const timestamp = String(NOW_SECONDS);
    const headers = {
      'x-inverge-timestamp': timestamp,
      'x-inverge-signature': signature(timestamp, BODY, 'other-secret'),
    };

    // #when the guard runs
    // #then it is rejected
    expect(() => setup().canActivate(context(BODY, headers))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a signature over a different body', () => {
    // #given a signature for another payload
    const timestamp = String(NOW_SECONDS);
    const headers = {
      'x-inverge-timestamp': timestamp,
      'x-inverge-signature': signature(timestamp, Buffer.from('{"events":[]}')),
    };

    // #when the guard runs against a changed body
    // #then it is rejected
    expect(() =>
      setup().canActivate(
        context(Buffer.from('{"events":[1]}'), headers),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('accepts a valid hex signature', () => {
    // #given a correctly signed request
    const timestamp = String(NOW_SECONDS);
    const headers = {
      'x-inverge-timestamp': timestamp,
      'x-inverge-signature': signature(timestamp),
    };

    // #when the guard runs
    // #then it allows the request
    expect(setup().canActivate(context(BODY, headers))).toBe(true);
  });

  it('accepts the sha256= prefix', () => {
    // #given a signature with the conventional prefix
    const timestamp = String(NOW_SECONDS);
    const headers = {
      'x-inverge-timestamp': timestamp,
      'x-inverge-signature': `sha256=${signature(timestamp)}`,
    };

    // #when the guard runs
    // #then it allows the request
    expect(setup().canActivate(context(BODY, headers))).toBe(true);
  });

  it('allows a timestamp at the skew boundary', () => {
    // #given a timestamp exactly at the allowed skew
    const timestamp = String(NOW_SECONDS - 300);
    const headers = {
      'x-inverge-timestamp': timestamp,
      'x-inverge-signature': signature(timestamp),
    };

    // #when the guard runs
    // #then it allows the request
    expect(setup().canActivate(context(BODY, headers))).toBe(true);
  });
});
