import { createHmac, timingSafeEqual } from 'node:crypto';
import { isDiditStatus, type DiditStatus } from './verification-status';

// Didit webhook authentication, implemented from the current documentation:
// https://docs.didit.me/integration/webhooks
//
//   X-Signature-V2      HMAC-SHA256 over canonical JSON (sorted keys, compact,
//                       Unicode preserved, whole-valued floats shortened). Recommended.
//   X-Signature         HMAC-SHA256 over the exact raw request bytes.
//   X-Signature-Simple  deprecated; authenticates the envelope only, never `decision`.
//   X-Timestamp         Unix seconds; reject when abs(now - ts) > 300.
//
// A rotated destination secret also sends `*-Previous` headers for 24 hours; a match
// on either header is accepted. The caller MUST re-fetch the decision when only the
// Simple signature matched, because it does not cover the payload.

export const DIDIT_TIMESTAMP_TOLERANCE_SECONDS = 300;

const SUPPORTED_EVENT_TYPES = new Set(['status.updated', 'data.updated']);

export type SignatureScheme = 'v2' | 'raw' | 'simple' | 'v2-previous' | 'raw-previous' | 'simple-previous';

export type SignatureVerdict =
  | {
      ok: true;
      scheme: SignatureScheme;
      /** False when only the deprecated envelope signature verified. */
      authenticatesPayload: boolean;
    }
  | { ok: false; reason: SignatureFailure };

export type SignatureFailure =
  | 'secret_missing'
  | 'timestamp_missing'
  | 'timestamp_invalid'
  | 'timestamp_out_of_tolerance'
  | 'signature_missing'
  | 'signature_mismatch';

export interface VerifySignatureInput {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  secret: string | undefined;
  /**
   * The previous destination secret during a 24-hour rotation. `*-Previous` headers are
   * HMACs made with this value, not with the current secret.
   */
  previousSecret?: string | undefined;
  nowSeconds?: number;
  toleranceSeconds?: number;
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }
  return null;
}

function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

function constantTimeEquals(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Didit normalises whole-valued floats to integers before hashing. */
export function shortenWholeFloats(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shortenWholeFloats);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        shortenWholeFloats(entry),
      ]),
    );
  }
  if (
    typeof value === 'number' &&
    !Number.isInteger(value) &&
    value % 1 === 0
  ) {
    return Math.trunc(value);
  }
  return value;
}

/** Recursively sorts keys; arrays keep their order. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/** The canonical JSON used by X-Signature-V2 (compact, Unicode preserved). */
export function canonicalJson(body: unknown): string {
  return JSON.stringify(sortKeysDeep(shortenWholeFloats(body)));
}

export function verifyDiditSignature(
  input: VerifySignatureInput,
): SignatureVerdict {
  const { headers, rawBody, secret } = input;
  if (!secret) return { ok: false, reason: 'secret_missing' };
  const previousSecret = input.previousSecret;

  const timestampHeader = header(headers, 'x-timestamp');
  if (!timestampHeader) return { ok: false, reason: 'timestamp_missing' };
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { ok: false, reason: 'timestamp_invalid' };
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance =
    input.toleranceSeconds ?? DIDIT_TIMESTAMP_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'signature_mismatch' };
  }

  const candidates: Array<{
    scheme: SignatureScheme;
    value: string | null;
    authenticatesPayload: boolean;
    expected: () => string;
  }> = [
    {
      scheme: 'v2',
      value: header(headers, 'x-signature-v2'),
      authenticatesPayload: true,
      expected: () => hmacHex(secret, canonicalJson(parsed)),
    },
    {
      scheme: 'raw',
      value: header(headers, 'x-signature'),
      authenticatesPayload: true,
      expected: () => hmacHex(secret, rawBody),
    },
    {
      scheme: 'simple',
      value: header(headers, 'x-signature-simple'),
      authenticatesPayload: false,
      expected: () => {
        const body = parsed as Record<string, unknown>;
        const message = [
          body.timestamp ?? '',
          body.session_id ?? '',
          body.status ?? '',
          body.webhook_type ?? '',
        ].join(':');
        return hmacHex(secret, message);
      },
    },
    {
      scheme: 'v2-previous',
      value: previousSecret ? header(headers, 'x-signature-v2-previous') : null,
      authenticatesPayload: true,
      expected: () => hmacHex(previousSecret ?? '', canonicalJson(parsed)),
    },
    {
      scheme: 'raw-previous',
      value: previousSecret ? header(headers, 'x-signature-previous') : null,
      authenticatesPayload: true,
      expected: () => hmacHex(previousSecret ?? '', rawBody),
    },
    {
      scheme: 'simple-previous',
      value: previousSecret ? header(headers, 'x-signature-simple-previous') : null,
      authenticatesPayload: false,
      expected: () => {
        const body = parsed as Record<string, unknown>;
        const message = [
          body.timestamp ?? '',
          body.session_id ?? '',
          body.status ?? '',
          body.webhook_type ?? '',
        ].join(':');
        return hmacHex(previousSecret ?? '', message);
      },
    },
  ];

  // Prefer a payload-authenticating scheme: a valid Simple signature must not
  // short-circuit a V2 check that would have failed.
  const ordered = [
    ...candidates.filter((candidate) => candidate.authenticatesPayload),
    ...candidates.filter((candidate) => !candidate.authenticatesPayload),
  ];

  for (const candidate of ordered) {
    if (!candidate.value) continue;
    if (constantTimeEquals(candidate.expected(), candidate.value.trim())) {
      return {
        authenticatesPayload: candidate.authenticatesPayload,
        ok: true,
        scheme: candidate.scheme,
      };
    }
  }

  return { ok: false, reason: 'signature_mismatch' };
}

export interface DiditWebhookEnvelope {
  eventId: string;
  webhookType: string;
  sessionId: string;
  businessSessionId: string | null;
  sessionKind: 'user' | 'business' | null;
  status: DiditStatus | null;
  rawStatus: string | null;
  vendorData: string | null;
  vendorBusinessId: string | null;
  workflowId: string | null;
  sandbox: boolean;
  /** The provider's decision object, only when the payload signature verified. */
  decision: Record<string, unknown> | null;
  resubmitInfo: Record<string, unknown> | null;
  occurredAt: Date;
  timestamp: number;
}

export type EnvelopeResult =
  | { ok: true; event: DiditWebhookEnvelope; ignorable: boolean }
  | { ok: false; reason: 'malformed' | 'unsupported_event' };

export interface ParseEnvelopeInput {
  rawBody: string;
  /** True only when the verified signature covered the body (V2 or raw). */
  payloadAuthenticated: boolean;
}

/**
 * Validates the envelope. Unknown status strings are preserved as `null` rather than
 * coerced: the service maps null to ERROR, never to Approved. Payload fields are only
 * exposed when a body-covering signature verified.
 */
export function parseDiditEnvelope(
  input: ParseEnvelopeInput,
): EnvelopeResult {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(input.rawBody) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'malformed' };
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const eventId = asString(body.event_id);
  const webhookType = asString(body.webhook_type);
  const sessionId = asString(body.session_id);
  if (!eventId || !webhookType || !sessionId) {
    return { ok: false, reason: 'malformed' };
  }
  if (!SUPPORTED_EVENT_TYPES.has(webhookType)) {
    return { ok: false, reason: 'unsupported_event' };
  }

  const rawStatus = asString(body.status);
  const timestamp = Number(body.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { ok: false, reason: 'malformed' };
  }

  const sessionKind =
    body.session_kind === 'business'
      ? 'business'
      : body.session_kind === 'user'
        ? 'user'
        : null;

  const decision =
    input.payloadAuthenticated &&
    body.decision &&
    typeof body.decision === 'object' &&
    !Array.isArray(body.decision)
      ? (body.decision as Record<string, unknown>)
      : null;

  return {
    event: {
      businessSessionId: asString(body.business_session_id),
      decision,
      eventId,
      occurredAt: new Date(
        typeof body.created_at === 'number' ? body.created_at * 1000 : timestamp * 1000,
      ),
      rawStatus,
      resubmitInfo:
        body.resubmit_info && typeof body.resubmit_info === 'object'
          ? (body.resubmit_info as Record<string, unknown>)
          : null,
      sandbox: body.environment === 'sandbox',
      sessionId,
      sessionKind,
      status: isDiditStatus(rawStatus) ? rawStatus : null,
      timestamp,
      vendorBusinessId: asString(body.vendor_business_id),
      vendorData: asString(body.vendor_data),
      webhookType,
      workflowId: asString(body.workflow_id),
    },
    ignorable: false,
    ok: true,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
