import { createHmac } from 'node:crypto';
import {
  nextDeliveryStatus,
  parseResendWebhook,
  verifyResendWebhook,
} from './resend-webhook';

const RAW_SECRET = 'resend-test-webhook-secret';
const SECRET = `whsec_${Buffer.from(RAW_SECRET).toString('base64')}`;
const NOW = 1_800_000_000;

function signed(body: string, id = 'msg_1', timestamp = NOW) {
  const signature = createHmac('sha256', Buffer.from(RAW_SECRET))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return {
    'svix-id': id,
    'svix-signature': `v1,${signature}`,
    'svix-timestamp': String(timestamp),
  };
}

describe('verifyResendWebhook', () => {
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'p1' } });

  it('accepts a correctly signed, fresh event', () => {
    const verdict = verifyResendWebhook({
      headers: signed(body),
      nowSeconds: NOW,
      rawBody: body,
      secret: SECRET,
    });
    expect(verdict).toEqual({ ok: true, eventId: 'msg_1' });
  });

  it('rejects a tampered body', () => {
    const verdict = verifyResendWebhook({
      headers: signed(body),
      nowSeconds: NOW,
      rawBody: `${body} `,
      secret: SECRET,
    });
    expect(verdict).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a replay outside the tolerance window', () => {
    const verdict = verifyResendWebhook({
      headers: signed(body),
      nowSeconds: NOW + 301,
      rawBody: body,
      secret: SECRET,
    });
    expect(verdict).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('rejects a missing or malformed secret before touching the body', () => {
    expect(
      verifyResendWebhook({ headers: signed(body), rawBody: body, secret: undefined }),
    ).toEqual({ ok: false, reason: 'secret_missing' });
    expect(
      verifyResendWebhook({ headers: signed(body), rawBody: body, secret: 'not-whsec' }),
    ).toEqual({ ok: false, reason: 'secret_invalid' });
  });

  it('accepts a rotated secret alongside the current one', () => {
    const bodyWithTwo = {
      ...signed(body),
      'svix-signature': `v1,AAAA ${signed(body)['svix-signature']}`,
    };
    expect(
      verifyResendWebhook({
        headers: bodyWithTwo,
        nowSeconds: NOW,
        rawBody: body,
        secret: SECRET,
      }).ok,
    ).toBe(true);
  });
});

describe('parseResendWebhook', () => {
  it('normalizes a delivered event and its recipient', () => {
    const event = parseResendWebhook(
      JSON.stringify({
        type: 'email.delivered',
        created_at: '2026-11-02T10:00:00.000Z',
        data: { email_id: 'p1', to: ['Ada@Example.test'], tags: [{ name: 'delivery_id', value: 'd1' }] },
      }),
    );

    expect(event).toMatchObject({
      event: 'DELIVERED',
      hardBounce: false,
      providerMessageId: 'p1',
      deliveryId: 'd1',
      recipient: 'Ada@Example.test',
      rawType: 'email.delivered',
    });
    expect(event?.occurredAt.toISOString()).toBe('2026-11-02T10:00:00.000Z');
  });

  it('distinguishes a permanent bounce from a transient one', () => {
    const permanent = parseResendWebhook(
      JSON.stringify({
        type: 'email.bounced',
        data: { email_id: 'p1', to: 'a@b.test', bounce: { type: 'Permanent' } },
      }),
    );
    const transient = parseResendWebhook(
      JSON.stringify({
        type: 'email.bounced',
        data: { email_id: 'p1', to: 'a@b.test', bounce: { type: 'Transient' } },
      }),
    );

    expect(permanent?.hardBounce).toBe(true);
    expect(transient?.hardBounce).toBe(false);
  });

  it('marks unknown provider events as ignored but still parses the envelope', () => {
    expect(
      parseResendWebhook(JSON.stringify({ type: 'email.opened', data: { email_id: 'p1' } })),
    ).toMatchObject({ event: 'IGNORED', providerMessageId: 'p1' });
  });

  it('treats a provider-side suppression as a failed send', () => {
    expect(
      parseResendWebhook(
        JSON.stringify({ type: 'email.suppressed', data: { email_id: 'p1' } }),
      ),
    ).toMatchObject({ event: 'FAILED' });
  });

  it('returns null for malformed JSON or a missing type', () => {
    expect(parseResendWebhook('not json')).toBeNull();
    expect(parseResendWebhook(JSON.stringify({ data: {} }))).toBeNull();
  });
});

describe('nextDeliveryStatus', () => {
  it('promotes an accepted message to delivered', () => {
    expect(nextDeliveryStatus('SENT', 'DELIVERED')).toBe('DELIVERED');
  });

  it('does not roll a delivery back to delayed or sent', () => {
    expect(nextDeliveryStatus('DELIVERED', 'DELAYED')).toBeNull();
    expect(nextDeliveryStatus('DELIVERED', 'SENT')).toBeNull();
  });

  it('lets a late bounce or complaint win', () => {
    expect(nextDeliveryStatus('DELIVERED', 'BOUNCED')).toBe('BOUNCED');
    expect(nextDeliveryStatus('DELIVERED', 'COMPLAINED')).toBe('COMPLAINED');
  });

  it('never reopens a terminal failure', () => {
    expect(nextDeliveryStatus('BOUNCED', 'DELIVERED')).toBeNull();
    expect(nextDeliveryStatus('COMPLAINED', 'DELIVERED')).toBeNull();
  });

  it('records a failure only before delivery', () => {
    expect(nextDeliveryStatus('SENT', 'FAILED')).toBe('FAILED');
    expect(nextDeliveryStatus('DELIVERED', 'FAILED')).toBeNull();
  });
});
