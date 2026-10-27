import {
  canonicalJson,
  parseDiditEnvelope,
  shortenWholeFloats,
  sortKeysDeep,
  verifyDiditSignature,
} from './didit-webhook-verifier';
import { createHmac } from 'node:crypto';

describe('canonicalJson', () => {
  it('sorts keys recursively and preserves array order', () => {
    expect(
      canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }),
    ).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it('shortens whole-valued floats the way Didit hashes them', () => {
    expect(shortenWholeFloats({ score: 1.0, nested: [2.0, 2.5] })).toEqual({
      nested: [2, 2.5],
      score: 1,
    });
    expect(sortKeysDeep({ b: 1, a: 2 })).toEqual({ a: 2, b: 1 });
  });
});

describe('parseDiditEnvelope', () => {
  const base = {
    created_at: 1_760_000_000,
    event_id: 'evt_1',
    session_id: 'sess_1',
    session_kind: 'user',
    status: 'Approved',
    timestamp: 1_760_000_000,
    vendor_data: 'user_1',
    webhook_type: 'status.updated',
    workflow_id: 'wf_1',
  };

  it('accepts a supported event and maps the exact status', () => {
    const parsed = parseDiditEnvelope({
      payloadAuthenticated: true,
      rawBody: JSON.stringify(base),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.event.status).toBe('Approved');
    expect(parsed.event.eventId).toBe('evt_1');
    expect(parsed.event.decision).toBeNull();
  });

  it('only exposes the decision when the payload signature verified', () => {
    const body = JSON.stringify({ ...base, decision: { status: 'Approved' } });
    const unauthenticated = parseDiditEnvelope({
      payloadAuthenticated: false,
      rawBody: body,
    });
    expect(unauthenticated.ok && unauthenticated.event.decision).toBeNull();
    const authenticated = parseDiditEnvelope({
      payloadAuthenticated: true,
      rawBody: body,
    });
    expect(authenticated.ok && authenticated.event.decision).toEqual({
      status: 'Approved',
    });
  });

  it('preserves an unknown status as null instead of coercing it', () => {
    const parsed = parseDiditEnvelope({
      payloadAuthenticated: true,
      rawBody: JSON.stringify({ ...base, status: 'Something New' }),
    });
    expect(parsed.ok && parsed.event.status).toBeNull();
    expect(parsed.ok && parsed.event.rawStatus).toBe('Something New');
  });

  it('rejects unsupported event types and malformed bodies', () => {
    expect(
      parseDiditEnvelope({
        payloadAuthenticated: true,
        rawBody: JSON.stringify({ ...base, webhook_type: 'session.created' }),
      }),
    ).toEqual({ ok: false, reason: 'unsupported_event' });
    expect(
      parseDiditEnvelope({ payloadAuthenticated: true, rawBody: 'not json' }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('verifyDiditSignature rotation', () => {
  const body = JSON.stringify({ session_id: 's', status: 'Approved', webhook_type: 'status.updated' });
  const secret = 'current';

  it('accepts a signature made with the previous secret during rotation', () => {
    const previous = createHmac('sha256', 'previous').update(body).digest('hex');
    const verdict = verifyDiditSignature({
      headers: { 'x-signature-previous': previous, 'x-timestamp': String(Math.floor(Date.now() / 1000)) },
      previousSecret: 'previous',
      rawBody: body,
      secret,
    });
    expect(verdict).toMatchObject({ authenticatesPayload: true, ok: true });
  });

  it('prefers a payload-authenticating scheme over Simple', () => {
    const ts = Math.floor(Date.now() / 1000);
    const parsed = JSON.parse(body);
    const simple = createHmac('sha256', secret)
      .update([parsed.timestamp ?? '', parsed.session_id, parsed.status, parsed.webhook_type].join(':'))
      .digest('hex');
    const verdict = verifyDiditSignature({
      headers: {
        'x-signature': 'wrong',
        'x-signature-simple': simple,
        'x-timestamp': String(ts),
      },
      nowSeconds: ts,
      rawBody: body,
      secret,
    });
    expect(verdict).toMatchObject({ authenticatesPayload: false, ok: true, scheme: 'simple' });
  });
});
