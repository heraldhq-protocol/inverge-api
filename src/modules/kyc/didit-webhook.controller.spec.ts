import { BadRequestException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { DiditWebhookController } from './didit-webhook.controller';
import type { VerificationService } from './verification.service';

describe('DiditWebhookController', () => {
  const handleWebhook = jest.fn();
  const controller = new DiditWebhookController({
    handleWebhook,
  } as unknown as VerificationService);

  beforeEach(() => {
    handleWebhook.mockReset();
  });

  it('passes the exact raw bytes and headers to the verifier', () => {
    const rawBody = Buffer.from(
      '{"event_id":"evt_1","status":"Approved","timestamp":1760000000}',
      'utf8',
    );
    const request = { rawBody } as RawBodyRequest<Request>;
    const headers = { 'x-signature-v2': 'sig' };

    controller.webhook(request, headers);

    expect(handleWebhook).toHaveBeenCalledWith(rawBody.toString('utf8'), headers);
  });

  it('rejects a request when the raw body was not captured', () => {
    expect(() =>
      controller.webhook({ rawBody: undefined } as RawBodyRequest<Request>, {}),
    ).toThrow(BadRequestException);
    expect(handleWebhook).not.toHaveBeenCalled();
  });
});
