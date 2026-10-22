import { NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationPort } from '../../ports/notification/notification.port';
import { NotificationsService } from './notifications.service';

type FakePrisma = {
  notification: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
  };
};

function fakePrisma(): FakePrisma {
  return {
    notification: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
  };
}

function fakePort(): NotificationPort & { send: jest.Mock } {
  return { send: jest.fn().mockResolvedValue(undefined) };
}

function fakeQueue(): Queue & { add: jest.Mock } {
  return { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue & {
    add: jest.Mock;
  };
}

function service(
  prisma: FakePrisma,
  port: NotificationPort,
  queue?: Queue,
): NotificationsService {
  return new NotificationsService(
    prisma as unknown as PrismaService,
    port,
    queue,
  );
}

describe('NotificationsService.notify', () => {
  it('persists the row before enqueueing delivery', async () => {
    const prisma = fakePrisma();
    const port = fakePort();
    const queue = fakeQueue();
    prisma.notification.create.mockResolvedValue({ id: 'n1' });

    await service(prisma, port, queue).notify({
      toUserId: 'u1',
      template: 'WAITLIST_CONVERSION',
      data: { ideaId: 'i1' },
      dedupeKey: 'WAITLIST_CONVERSION:c1:u1',
    });

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        template: 'WAITLIST_CONVERSION',
        data: { ideaId: 'i1' },
        dedupeKey: 'WAITLIST_CONVERSION:c1:u1',
      },
      select: { id: true },
    });
    expect(queue.add).toHaveBeenCalledWith(
      'dispatch',
      { notificationId: 'n1' },
      expect.objectContaining({
        jobId: 'notification:n1',
        attempts: 5,
      }),
    );
    // The worker owns delivery; the request path does not call the vendor.
    expect(port.send).not.toHaveBeenCalled();
  });

  it('treats a duplicate dedupe key as a no-op', async () => {
    const prisma = fakePrisma();
    const queue = fakeQueue();
    prisma.notification.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service(prisma, fakePort(), queue).notify({
        toUserId: 'u1',
        template: 'WAITLIST_CONVERSION',
        data: {},
        dedupeKey: 'same',
      }),
    ).resolves.toBeUndefined();

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('dispatches inline when the queue is not registered', async () => {
    const prisma = fakePrisma();
    const port = fakePort();
    prisma.notification.create.mockResolvedValue({ id: 'n1' });
    prisma.notification.findUnique.mockResolvedValue({
      id: 'n1',
      userId: 'u1',
      template: 'CAMPAIGN_FUNDED',
      data: { campaignId: 'c1' },
      dispatchedAt: null,
    });
    prisma.notification.update.mockResolvedValue({});

    await service(prisma, port).notify({
      toUserId: 'u1',
      template: 'CAMPAIGN_FUNDED',
      data: { campaignId: 'c1' },
    });

    expect(port.send).toHaveBeenCalledWith({
      toUserId: 'u1',
      template: 'CAMPAIGN_FUNDED',
      data: { campaignId: 'c1' },
    });
    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'n1' },
        data: expect.objectContaining({ lastDispatchError: null }),
      }),
    );
  });

  it('does not fail the domain action when inline delivery fails', async () => {
    const prisma = fakePrisma();
    const port = fakePort();
    prisma.notification.create.mockResolvedValue({ id: 'n1' });
    prisma.notification.findUnique.mockResolvedValue({
      id: 'n1',
      userId: 'u1',
      template: 'WAITLIST_CONVERSION',
      data: {},
      dispatchedAt: null,
    });
    prisma.notification.update.mockResolvedValue({});
    port.send.mockRejectedValue(new Error('vendor down'));

    await expect(
      service(prisma, port).notify({
        toUserId: 'u1',
        template: 'WAITLIST_CONVERSION',
        data: {},
      }),
    ).resolves.toBeUndefined();

    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastDispatchError: 'vendor down' }),
      }),
    );
  });
});

describe('NotificationsService.dispatch', () => {
  it('is a no-op for a missing or already dispatched row', async () => {
    const prisma = fakePrisma();
    const port = fakePort();
    prisma.notification.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ dispatchedAt: new Date() });

    await service(prisma, port).dispatch('missing');
    await service(prisma, port).dispatch('sent');

    expect(port.send).not.toHaveBeenCalled();
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('records the failure and rethrows so the worker retries', async () => {
    const prisma = fakePrisma();
    const port = fakePort();
    prisma.notification.findUnique.mockResolvedValue({
      id: 'n1',
      userId: 'u1',
      template: 'WAITLIST_CONVERSION',
      data: {},
      dispatchedAt: null,
    });
    prisma.notification.update.mockResolvedValue({});
    port.send.mockRejectedValue(new Error('timeout'));

    await expect(service(prisma, port).dispatch('n1')).rejects.toThrow(
      'timeout',
    );
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: {
        dispatchAttempts: { increment: 1 },
        lastDispatchError: 'timeout',
      },
    });
  });
});

describe('NotificationsService read model', () => {
  it('pages newest first and returns ISO timestamps', async () => {
    const prisma = fakePrisma();
    const createdAt = new Date('2026-10-22T12:00:00.000Z');
    prisma.notification.findMany.mockResolvedValue([
      {
        id: 'n2',
        template: 'WAITLIST_CONVERSION',
        data: { ideaId: 'i1' },
        readAt: null,
        createdAt,
      },
      {
        id: 'n1',
        template: 'CAMPAIGN_FUNDED',
        data: null,
        readAt: createdAt,
        createdAt: new Date('2026-10-21T12:00:00.000Z'),
      },
    ]);

    const result = await service(prisma, fakePort()).list('u1', {
      limit: 1,
      unreadOnly: true,
    });

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', readAt: null },
        take: 2,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(result.data).toEqual([
      {
        id: 'n2',
        template: 'WAITLIST_CONVERSION',
        data: { ideaId: 'i1' },
        readAt: null,
        createdAt: '2026-10-22T12:00:00.000Z',
      },
    ]);
    expect(result.page).toMatchObject({
      limit: 1,
      hasMore: true,
      total: null,
      totalKind: 'omitted',
    });
    expect(result.page.nextCursor).toEqual(expect.any(String));
  });

  it('404s a notification owned by another user', async () => {
    const prisma = fakePrisma();
    prisma.notification.findFirst.mockResolvedValue(null);

    await expect(
      service(prisma, fakePort()).markRead('u1', 'n2'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('is idempotent when the notification is already read', async () => {
    const prisma = fakePrisma();
    prisma.notification.findFirst.mockResolvedValue({
      id: 'n1',
      readAt: new Date('2026-10-22T12:00:00.000Z'),
    });

    await expect(
      service(prisma, fakePort()).markRead('u1', 'n1'),
    ).resolves.toEqual({ id: 'n1', readAt: '2026-10-22T12:00:00.000Z' });
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('marks every unread row for the signed-in user', async () => {
    const prisma = fakePrisma();
    prisma.notification.updateMany.mockResolvedValue({ count: 3 });

    await expect(
      service(prisma, fakePort()).markAllRead('u1'),
    ).resolves.toEqual({ updated: 3 });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });
});
