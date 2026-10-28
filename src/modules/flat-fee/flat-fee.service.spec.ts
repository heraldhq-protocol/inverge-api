import { BadRequestException } from '@nestjs/common';
import { FlatFeeService } from './flat-fee.service';
import { FLATFEE_SUCCEEDED } from './flat-fee.events';

// The flat-fee rail (FR-406) — deliberately separate from any escrow / on-ramp flow.
// Fulfilment is decoupled via an event, so this service carries no back-dependency.
function setup(charge: any = { id: 'c1', userId: 'u1', purpose: 'BOOST', status: 'PENDING', metadata: { ideaId: 'i1' } }) {
  const processor = {
    createCharge: jest.fn().mockResolvedValue({ processorRef: 'ref_1', redirectUrl: 'https://pay/ref_1' }),
    parseWebhook: jest.fn(),
  };
  const prisma = {
    flatFeeCharge: {
      create: jest.fn().mockResolvedValue(charge),
      findUnique: jest.fn().mockResolvedValue(charge),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  } as any;
  const events = { emit: jest.fn() } as any;
  const svc = new FlatFeeService(processor as any, prisma, events);
  return { svc, processor, prisma, events };
}

describe('FlatFeeService.createCharge', () => {
  it('persists a PENDING charge and returns the processor redirect', async () => {
    const { svc, prisma, processor } = setup();
    const res = await svc.createCharge({ userId: 'u1', purpose: 'BOOST', amount: 5000, currency: 'NGN' });
    expect(processor.createCharge).toHaveBeenCalled();
    expect(prisma.flatFeeCharge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processorRef: 'ref_1',
          redirectUrl: 'https://pay/ref_1',
          status: 'PENDING',
        }),
      }),
    );
    expect(res).toEqual({
      chargeId: 'c1',
      processorRef: 'ref_1',
      redirectUrl: 'https://pay/ref_1',
    });
  });

  it('retires only a still-pending charge', async () => {
    const { svc, prisma } = setup();
    await svc.voidCharge('c1');
    expect(prisma.flatFeeCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', status: 'PENDING' },
      data: { status: 'FAILED' },
    });
  });
});

describe('FlatFeeService.handleWebhook', () => {
  it('rejects an unverifiable webhook', async () => {
    const { svc, processor } = setup();
    processor.parseWebhook.mockReturnValue(null); // signature invalid
    await expect(svc.handleWebhook('{}', 'bad-sig')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignores a webhook for an unknown charge', async () => {
    const { svc, processor, prisma } = setup();
    processor.parseWebhook.mockReturnValue({ processorRef: 'ref_x', status: 'SUCCEEDED', raw: {} });
    prisma.flatFeeCharge.findUnique.mockResolvedValue(null);
    expect(await svc.handleWebhook('{}', 'sig')).toEqual({ ignored: true });
  });

  it('is idempotent: a charge already out of PENDING is a no-op (no re-emit)', async () => {
    const { svc, processor, prisma, events } = setup({ id: 'c1', userId: 'u1', purpose: 'BOOST', status: 'SUCCEEDED' });
    processor.parseWebhook.mockReturnValue({ processorRef: 'ref_1', status: 'SUCCEEDED', raw: {} });
    const res = await svc.handleWebhook('{}', 'sig');
    expect(res).toEqual({ idempotent: true });
    expect(prisma.flatFeeCharge.update).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('on success: marks SUCCEEDED and emits the fulfilment event', async () => {
    const { svc, processor, prisma, events } = setup();
    processor.parseWebhook.mockReturnValue({ processorRef: 'ref_1', status: 'SUCCEEDED', raw: {} });
    const res = await svc.handleWebhook('{}', 'sig');
    expect(prisma.flatFeeCharge.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'SUCCEEDED' } }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      FLATFEE_SUCCEEDED,
      expect.objectContaining({ chargeId: 'c1', userId: 'u1', purpose: 'BOOST' }),
    );
    expect(res).toEqual({ ok: true, status: 'SUCCEEDED' });
  });

  it('on failure: marks FAILED and does NOT emit fulfilment', async () => {
    const { svc, processor, prisma, events } = setup();
    processor.parseWebhook.mockReturnValue({ processorRef: 'ref_1', status: 'FAILED', raw: {} });
    await svc.handleWebhook('{}', 'sig');
    expect(prisma.flatFeeCharge.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'FAILED' } }),
    );
    expect(events.emit).not.toHaveBeenCalled();
  });
});
