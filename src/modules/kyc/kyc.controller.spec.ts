import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { KycController } from './kyc.controller';
import type { KycService } from './kyc.service';

const configFor = (values: Pick<Env, 'NODE_ENV' | 'KYC_PROVIDER'>) =>
  ({
    get: (key: 'NODE_ENV' | 'KYC_PROVIDER') => values[key],
  }) as unknown as ConfigService<Env, true>;

const controllerFor = (values: Pick<Env, 'NODE_ENV' | 'KYC_PROVIDER'>) => {
  const handleWebhook = jest.fn().mockResolvedValue({ accepted: true });
  const controller = new KycController(
    { handleWebhook } as unknown as KycService,
    configFor(values),
  );
  return { controller, handleWebhook };
};

describe('KycController dev-complete (F-01)', () => {
  it('is a non-disclosing 404 in production even if the stub were still selected', () => {
    const { controller, handleWebhook } = controllerFor({
      NODE_ENV: 'production',
      KYC_PROVIDER: 'stub',
    });

    expect(() =>
      controller.devComplete('stub-ref', 'user-1'),
    ).toThrow(NotFoundException);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('is a 404 in production when a real provider is selected', () => {
    const { controller, handleWebhook } = controllerFor({
      NODE_ENV: 'production',
      KYC_PROVIDER: 'didit',
    });

    expect(() =>
      controller.devComplete('didit-ref', 'user-1'),
    ).toThrow(NotFoundException);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('is unavailable outside production when a real provider is selected', () => {
    const { controller, handleWebhook } = controllerFor({
      NODE_ENV: 'development',
      KYC_PROVIDER: 'didit',
    });

    expect(() =>
      controller.devComplete('didit-ref', 'user-1'),
    ).toThrow(NotFoundException);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('remains available to the offline flow outside production', async () => {
    const { controller, handleWebhook } = controllerFor({
      NODE_ENV: 'test',
      KYC_PROVIDER: 'stub',
    });

    await controller.devComplete('stub-ref', 'user-1', 'VERIFIED', 'CLEAR');

    expect(handleWebhook).toHaveBeenCalledWith(
      JSON.stringify({
        providerRef: 'stub-ref',
        vendor_data: 'user-1',
        status: 'VERIFIED',
        aml: 'CLEAR',
      }),
      {},
    );
  });
});
