import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookInboxService } from './webhook-inbox.service';

type FakePrisma = {
  webhookReceipt: {
    create: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
  };
};

function fakePrisma(): FakePrisma {
  return {
    webhookReceipt: {
      create: jest.fn().mockResolvedValue({ id: 'w1' }),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

function service(prisma: FakePrisma): WebhookInboxService {
  return new WebhookInboxService(prisma as unknown as PrismaService);
}

const input = {
  provider: 'PAYSTACK' as const,
  rawBody: '{"event":"charge.success"}',
  dedupeKey: 'PAYSTACK:ref1:SUCCEEDED',
  eventType: 'SUCCEEDED',
};

describe('WebhookInboxService', () => {
  it('records a verified event, claims it, then applies exactly once', async () => {
    const prisma = fakePrisma();
    const apply = jest.fn().mockResolvedValue({ ok: true });

    await expect(service(prisma).run(input, apply)).resolves.toEqual({ ok: true });

    expect(prisma.webhookReceipt.create).toHaveBeenCalledWith({
      data: {
        provider: 'PAYSTACK',
        dedupeKey: 'PAYSTACK:ref1:SUCCEEDED',
        payloadHash: createHash('sha256').update(input.rawBody).digest('hex'),
        eventType: 'SUCCEEDED',
      },
      select: { id: true },
    });
    expect(prisma.webhookReceipt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'w1' }),
        data: expect.objectContaining({ status: 'PROCESSING' }),
      }),
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(prisma.webhookReceipt.update).toHaveBeenCalledWith({
      where: { id: 'w1' },
      data: {
        status: 'PROCESSED',
        processedAt: expect.any(Date),
        lockedAt: null,
        lastError: null,
      },
    });
  });

  it('marks an ignored event so a replay does not reapply it', async () => {
    const prisma = fakePrisma();

    await service(prisma).run(input, async () => ({ ignored: true }));

    expect(prisma.webhookReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'IGNORED' }),
      }),
    );
  });

  it('reclaims the same dedupe key after a unique-constraint race', async () => {
    const prisma = fakePrisma();
    prisma.webhookReceipt.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    prisma.webhookReceipt.findUniqueOrThrow.mockResolvedValue({ id: 'existing' });

    await service(prisma).run(input, async () => ({ ok: true }));

    expect(prisma.webhookReceipt.findUniqueOrThrow).toHaveBeenCalledWith({
      where: {
        provider_dedupeKey: {
          provider: 'PAYSTACK',
          dedupeKey: 'PAYSTACK:ref1:SUCCEEDED',
        },
      },
      select: { id: true },
    });
    expect(prisma.webhookReceipt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'existing' }) }),
    );
  });

  it('does not apply a second time when the row was already processed', async () => {
    const prisma = fakePrisma();
    prisma.webhookReceipt.updateMany.mockResolvedValue({ count: 0 });
    prisma.webhookReceipt.findUniqueOrThrow.mockResolvedValue({
      status: 'PROCESSED',
    });
    const apply = jest.fn();

    await expect(service(prisma).run(input, apply)).resolves.toEqual({
      replayed: true,
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('reports an in-flight duplicate without applying it', async () => {
    const prisma = fakePrisma();
    prisma.webhookReceipt.updateMany.mockResolvedValue({ count: 0 });
    prisma.webhookReceipt.findUniqueOrThrow.mockResolvedValue({
      status: 'PROCESSING',
    });
    const apply = jest.fn();

    await expect(service(prisma).run(input, apply)).resolves.toEqual({
      inProgress: true,
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('marks a failed apply and rethrows so the provider retries', async () => {
    const prisma = fakePrisma();

    await expect(
      service(prisma).run(input, async () => {
        throw new Error('payment state conflict');
      }),
    ).rejects.toThrow('payment state conflict');

    expect(prisma.webhookReceipt.update).toHaveBeenCalledWith({
      where: { id: 'w1' },
      data: {
        status: 'FAILED',
        lockedAt: null,
        lastError: 'payment state conflict',
      },
    });
  });

  it('falls back to the payload hash when no event key is supplied', async () => {
    const prisma = fakePrisma();

    await service(prisma).run(
      { provider: 'DIDIT', rawBody: '{"session_id":"s1"}' },
      async () => ({ ok: true }),
    );

    expect(prisma.webhookReceipt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: createHash('sha256')
            .update('{"session_id":"s1"}')
            .digest('hex'),
          payloadHash: createHash('sha256')
            .update('{"session_id":"s1"}')
            .digest('hex'),
        }),
      }),
    );
  });
});
