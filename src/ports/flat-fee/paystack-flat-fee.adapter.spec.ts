import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { PaystackFlatFeeAdapter } from './paystack-flat-fee.adapter';

const WEBHOOK_SECRET = 'paystack-test-webhook-secret';

const config = {
  get: (key: keyof Env) => {
    if (key === 'PAYSTACK_WEBHOOK_SECRET') return WEBHOOK_SECRET;
    if (key === 'PAYSTACK_SECRET_KEY') return 'sk_test_example';
    return undefined;
  },
} as unknown as ConfigService<Env, true>;

const sign = (body: string, secret = WEBHOOK_SECRET) =>
  createHmac('sha512', secret).update(body).digest('hex');

const successBody = JSON.stringify({
  event: 'charge.success',
  data: { reference: 'ps_ref_1', status: 'success' },
});

describe('PaystackFlatFeeAdapter webhook verification (F-01)', () => {
  const adapter = new PaystackFlatFeeAdapter(config);

  it('accepts a success callback carrying a valid signature', () => {
    expect(adapter.parseWebhook(successBody, sign(successBody))).toMatchObject({
      processorRef: 'ps_ref_1',
      status: 'SUCCEEDED',
    });
  });

  it('rejects an unsigned body even when it claims success', () => {
    expect(adapter.parseWebhook(successBody)).toBeNull();
  });

  it('rejects a forged signature', () => {
    expect(adapter.parseWebhook(successBody, sign(successBody, 'wrong'))).toBeNull();
    expect(adapter.parseWebhook(successBody, 'not-a-hex-signature')).toBeNull();
  });

  it('rejects a body altered after signing', () => {
    const signature = sign(successBody);
    const tampered = JSON.stringify({
      event: 'charge.success',
      data: { reference: 'attacker-ref', status: 'success' },
    });
    expect(adapter.parseWebhook(tampered, signature)).toBeNull();
  });

  it('maps a signed non-success event to FAILED rather than SUCCEEDED', () => {
    const failed = JSON.stringify({
      event: 'charge.failed',
      data: { reference: 'ps_ref_2' },
    });
    expect(adapter.parseWebhook(failed, sign(failed))).toMatchObject({
      processorRef: 'ps_ref_2',
      status: 'FAILED',
    });
  });

  it('rejects a signed body that has no transaction reference', () => {
    const noRef = JSON.stringify({ event: 'charge.success', data: {} });
    expect(adapter.parseWebhook(noRef, sign(noRef))).toBeNull();
  });

  it('rejects every callback when no key is provisioned', () => {
    const unconfigured = new PaystackFlatFeeAdapter({
      get: () => undefined,
    } as unknown as ConfigService<Env, true>);
    expect(unconfigured.parseWebhook(successBody, sign(successBody))).toBeNull();
  });
});
