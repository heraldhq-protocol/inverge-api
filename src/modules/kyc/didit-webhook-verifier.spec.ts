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
  const now = () => Math.floor(Date.now() / 1000);
  const base = {
    created_at: now(),
    event_id: 'evt_1',
    session_id: 'sess_1',
    session_kind: 'user',
    status: 'Approved',
    timestamp: now(),
    vendor_data: 'user_1',
    webhook_type: 'status.updated',
    workflow_id: 'wf_1',
  };

  it('accepts a supported session event and maps the exact status', () => {
    const parsed = parseDiditEnvelope({
      payloadAuthenticated: true,
      rawBody: JSON.stringify(base),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.event.resourceType).toBe('SESSION');
    expect(parsed.event.resourceId).toBe('sess_1');
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

  it('accepts every supported event family', () => {
    const cases = [
      { expected: 'SESSION', body: base },
      {
        expected: 'USER',
        body: {
          ...base,
          session_id: undefined,
          vendor_user_id: 'vendor-user-1',
          webhook_type: 'user.status.updated',
          status: 'BLOCKED',
          previous_status: 'ACTIVE',
        },
      },
      {
        expected: 'BUSINESS',
        body: {
          ...base,
          session_id: undefined,
          vendor_business_id: 'vendor-business-1',
          webhook_type: 'business.data.updated',
          status: 'ACTIVE',
          changed_fields: ['metadata'],
        },
      },
      {
        expected: 'ACTIVITY',
        body: {
          ...base,
          session_id: undefined,
          webhook_type: 'activity.created',
        },
      },
      {
        expected: 'TRANSACTION',
        body: {
          ...base,
          created_at: undefined,
          session_id: undefined,
          transaction_id: 'txn_1',
          txn_id: 'finance0001',
          webhook_type: 'transaction.created',
          status: 'APPROVED',
          amount: '1200.00',
          currency: 'EUR',
          direction: 'OUTBOUND',
          score: 0,
        },
      },
    ];

    for (const entry of cases) {
      const parsed = parseDiditEnvelope({
        payloadAuthenticated: true,
        rawBody: JSON.stringify(entry.body),
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.event.resourceType).toBe(entry.expected);
    }
  });

  it('captures transaction fields for a transaction event', () => {
    const parsed = parseDiditEnvelope({
      payloadAuthenticated: true,
      rawBody: JSON.stringify({
        ...base,
        session_id: undefined,
        transaction_id: 'txn_1',
        txn_id: 'finance0001',
        webhook_type: 'transaction.created',
        status: 'APPROVED',
        amount: '1200.00',
        currency: 'EUR',
        direction: 'OUTBOUND',
        score: 0,
      }),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.event.transaction).toMatchObject({
      amount: '1200.00',
      currency: 'EUR',
      direction: 'OUTBOUND',
      score: 0,
      status: 'APPROVED',
      txnId: 'finance0001',
    });
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

  it('rejects a session event without session_id', () => {
    expect(
      parseDiditEnvelope({
        payloadAuthenticated: true,
        rawBody: JSON.stringify({ ...base, session_id: undefined }),
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('verifyDiditSignature', () => {
  const secret = 'shhh';
  const now = () => Math.floor(Date.now() / 1000);
  const bodyFor = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: 's1',
      status: 'Approved',
      timestamp: now(),
      webhook_type: 'status.updated',
      ...overrides,
    });

  it('accepts a correct raw-body HMAC (x-signature)', () => {
    const body = bodyFor();
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(
      verifyDiditSignature({
        headers: { 'x-signature': sig },
        rawBody: body,
        secret,
      }).ok,
    ).toBe(true);
  });

  it('rejects a wrong signature', () => {
    const verdict = verifyDiditSignature({
      headers: { 'x-signature': 'deadbeef' },
      rawBody: bodyFor(),
      secret,
    });
    expect(verdict).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects when no signature header is present', () => {
    const verdict = verifyDiditSignature({
      headers: { 'x-timestamp': String(now()) },
      rawBody: bodyFor(),
      secret,
    });
    expect(verdict).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a stale body timestamp even when the unsigned header is fresh', () => {
    const body = bodyFor({ timestamp: now() - 10_000 });
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    const verdict = verifyDiditSignature({
      headers: {
        'x-signature': sig,
        // An attacker can freshen this header on a replay; it must be ignored.
        'x-timestamp': String(now()),
      },
      rawBody: body,
      secret,
    });
    expect(verdict).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('rejects a signed body with no timestamp', () => {
    const body = JSON.stringify({
      session_id: 's1',
      status: 'Approved',
      webhook_type: 'status.updated',
    });
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    const verdict = verifyDiditSignature({
      headers: { 'x-signature': sig, 'x-timestamp': String(now()) },
      rawBody: body,
      secret,
    });
    expect(verdict).toEqual({ ok: false, reason: 'timestamp_missing' });
  });

  it('rejects when no secret is configured', () => {
    const verdict = verifyDiditSignature({
      headers: { 'x-timestamp': String(now()) },
      rawBody: bodyFor(),
      secret: undefined,
    });
    expect(verdict).toEqual({ ok: false, reason: 'secret_missing' });
  });

  it('accepts the canonical V2 signature', () => {
    const ts = now();
    const body = bodyFor({ timestamp: ts });
    const canonical = canonicalJson(JSON.parse(body));
    const v2 = createHmac('sha256', secret).update(canonical).digest('hex');
    expect(
      verifyDiditSignature({
        headers: { 'x-signature-v2': v2 },
        nowSeconds: ts,
        rawBody: body,
        secret,
      }),
    ).toMatchObject({ authenticatesPayload: true, ok: true, scheme: 'v2' });
  });

  it('accepts a signature made with the previous secret during rotation', () => {
    const body = bodyFor();
    const previous = createHmac('sha256', 'previous').update(body).digest('hex');
    const verdict = verifyDiditSignature({
      headers: { 'x-signature-previous': previous },
      previousSecret: 'previous',
      rawBody: body,
      secret,
    });
    expect(verdict).toMatchObject({ authenticatesPayload: true, ok: true });
  });

  it('flags the deprecated Simple signature as not payload-authenticating', () => {
    const ts = now();
    const body = bodyFor({ timestamp: ts });
    const parsed = JSON.parse(body);
    const message = [
      parsed.timestamp ?? '',
      parsed.session_id,
      parsed.status,
      parsed.webhook_type,
    ].join(':');
    const simple = createHmac('sha256', secret).update(message).digest('hex');
    expect(
      verifyDiditSignature({
        headers: { 'x-signature-simple': simple },
        nowSeconds: ts,
        rawBody: body,
        secret,
      }),
    ).toMatchObject({
      authenticatesPayload: false,
      ok: true,
      scheme: 'simple',
    });
  });

  it('prefers a payload-authenticating scheme over Simple', () => {
    const ts = now();
    const body = bodyFor({ timestamp: ts });
    const parsed = JSON.parse(body);
    const simple = createHmac('sha256', secret)
      .update(
        [
          parsed.timestamp ?? '',
          parsed.session_id,
          parsed.status,
          parsed.webhook_type,
        ].join(':'),
      )
      .digest('hex');
    const verdict = verifyDiditSignature({
      headers: {
        'x-signature': 'wrong',
        'x-signature-simple': simple,
      },
      nowSeconds: ts,
      rawBody: body,
      secret,
    });
    expect(verdict).toMatchObject({
      authenticatesPayload: false,
      ok: true,
      scheme: 'simple',
    });
  });
});
