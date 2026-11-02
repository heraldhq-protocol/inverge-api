import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EmailDeliveryStatus } from '../../generated/prisma/client';

export const RESEND_TIMESTAMP_TOLERANCE_SECONDS = 300;

export type ResendSignatureFailure =
  | 'secret_missing'
  | 'secret_invalid'
  | 'timestamp_missing'
  | 'timestamp_invalid'
  | 'timestamp_out_of_tolerance'
  | 'signature_missing'
  | 'signature_mismatch';

export type ResendSignatureVerdict =
  | { ok: true; eventId: string }
  | { ok: false; reason: ResendSignatureFailure };

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

function constantTimeEquals(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Resend signs webhooks with Svix. The signed content is
 * `<svix-id>.<svix-timestamp>.<raw body>`, HMAC-SHA256 with the base64-decoded
 * `whsec_` secret, base64-encoded in one or more `v1,<sig>` entries.
 *
 * The timestamp is checked after the signature, so a replay cannot merely
 * refresh the header without invalidating the MAC.
 */
export function verifyResendWebhook(input: {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  secret: string | undefined;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): ResendSignatureVerdict {
  const { rawBody, headers, secret } = input;
  if (!secret) return { ok: false, reason: 'secret_missing' };
  if (!secret.startsWith('whsec_')) return { ok: false, reason: 'secret_invalid' };

  let key: Buffer;
  try {
    key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  } catch {
    return { ok: false, reason: 'secret_invalid' };
  }
  if (key.length === 0) return { ok: false, reason: 'secret_invalid' };

  const eventId = header(headers, 'svix-id');
  const rawTimestamp = header(headers, 'svix-timestamp');
  const signatures = header(headers, 'svix-signature');
  if (!rawTimestamp) return { ok: false, reason: 'timestamp_missing' };
  if (!signatures) return { ok: false, reason: 'signature_missing' };
  if (!eventId) return { ok: false, reason: 'signature_missing' };

  const timestamp = Number(rawTimestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { ok: false, reason: 'timestamp_invalid' };
  }

  const expected = createHmac('sha256', key)
    .update(`${eventId}.${rawTimestamp}.${rawBody}`)
    .digest('base64');

  const matched = signatures
    .split(' ')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => entry.slice('v1,'.length))
    .some((signature) => constantTimeEquals(expected, signature));
  if (!matched) return { ok: false, reason: 'signature_mismatch' };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? RESEND_TIMESTAMP_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  return { ok: true, eventId };
}

export type ResendEvent =
  | 'SENT'
  | 'DELIVERED'
  | 'DELAYED'
  | 'BOUNCED'
  | 'COMPLAINED'
  | 'FAILED'
  | 'IGNORED';

export interface ResendDeliveryEvent {
  /** Normalized event name; unknown provider events become IGNORED. */
  event: ResendEvent;
  /** True only for `bounce.type === "Permanent"`. */
  hardBounce: boolean;
  /** Resend message id (`data.email_id`), the primary correlation key. */
  providerMessageId: string | null;
  /** Delivery row id echoed in Resend tags, when the provider returns it. */
  deliveryId: string | null;
  recipient: string | null;
  occurredAt: Date;
  rawType: string;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function firstRecipient(value: unknown): string | null {
  if (typeof value === 'string') return asString(value);
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const found = asString(entry);
    if (found) return found;
  }
  return null;
}

function deliveryTag(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (
        entry &&
        typeof entry === 'object' &&
        (entry as { name?: unknown }).name === 'delivery_id'
      ) {
        return asString((entry as { value?: unknown }).value);
      }
    }
    return null;
  }
  if (value && typeof value === 'object') {
    return asString((value as Record<string, unknown>).delivery_id);
  }
  return null;
}

const EVENT_MAP: Record<string, ResendEvent> = {
  'email.sent': 'SENT',
  'email.delivered': 'DELIVERED',
  'email.delivery_delayed': 'DELAYED',
  'email.bounced': 'BOUNCED',
  'email.complained': 'COMPLAINED',
  'email.failed': 'FAILED',
  // Resend can decline a message against its own suppression list. It was not
  // delivered, so it is recorded as a failure, not silently ignored.
  'email.suppressed': 'FAILED',
};

/** Parses a Resend webhook body. Returns null only for a malformed envelope. */
export function parseResendWebhook(rawBody: string): ResendDeliveryEvent | null {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const rawType = asString(body.type);
  if (!rawType) return null;
  const data =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : {};
  const event = EVENT_MAP[rawType] ?? 'IGNORED';

  const bounce =
    data.bounce && typeof data.bounce === 'object' && !Array.isArray(data.bounce)
      ? (data.bounce as Record<string, unknown>)
      : null;

  const occurredAt = new Date(
    typeof body.created_at === 'string' ? body.created_at : Date.now(),
  );

  return {
    deliveryId: deliveryTag(data.tags),
    event,
    hardBounce: asString(bounce?.type)?.toLowerCase() === 'permanent',
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
    providerMessageId: asString(data.email_id),
    rawType,
    recipient: firstRecipient(data.to) ?? asString(data.recipient),
  };
}

const RANK: Partial<Record<EmailDeliveryStatus, number>> = {
  PENDING: 0,
  SENDING: 1,
  DELAYED: 2,
  SENT: 3,
  DELIVERED: 4,
};

/**
 * Monotonic status merge. A late `delivered` never reopens a bounce or
 * complaint, and a delayed event never rolls back an accepted send. Returns null
 * when the event carries no new information.
 */
export function nextDeliveryStatus(
  current: EmailDeliveryStatus,
  event: ResendEvent,
): EmailDeliveryStatus | null {
  if (current === 'BOUNCED' || current === 'COMPLAINED') return null;

  switch (event) {
    case 'SENT':
      return current === 'PENDING' || current === 'SENDING' ? 'SENT' : null;
    case 'DELAYED':
      return (RANK[current] ?? 0) < (RANK.SENT ?? 3) ? 'DELAYED' : null;
    case 'DELIVERED':
      return current === 'DELIVERED' ? null : 'DELIVERED';
    case 'BOUNCED':
      return 'BOUNCED';
    case 'COMPLAINED':
      return 'COMPLAINED';
    case 'FAILED':
      return current === 'DELIVERED' ? null : 'FAILED';
    default:
      return null;
  }
}
