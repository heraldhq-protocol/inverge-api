import { NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { JOB_NAMES } from '../../common/queue/job-names';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryService } from '../email/email-delivery.service';
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

function fakeDelivery() {
  return {
    sendNotification: jest.fn().mockResolvedValue({
      status: 'sent',
      deliveryId: 'd1',
      providerMessageId: 'p1',
    }),
  } as unknown as jest.Mocked<EmailDeliveryService>;
}

type NotificationRow = {
  id: string;
  userId: string;
  template: string;
  data: Record<string, unknown>;
  dispatchedAt: Date | null;
  suppressedAt: Date | null;
  user: {
    email: string | null;
    emailVerifiedAt: Date | null;
    notifyEmailUpdates: boolean;
    notifyMilestoneReviews: boolean;
    notifyCreatorUpdates: boolean;
    notifyDiscoveryDigest: boolean;
  };
};

function notificationRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 'n1',
    userId: 'u1',
    template: 'CAMPAIGN_FUNDED',
    data: { campaignId: 'c1' },
    dispatchedAt: null,
    suppressedAt: null,
    user: {
      email: 'amara@example.test',
      emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
      notifyEmailUpdates: true,
      notifyMilestoneReviews: true,
      notifyCreatorUpdates: true,
      notifyDiscoveryDigest: false,
    },
    ...overrides,
  };
}

function fakeQueue(): Queue & { add: jest.Mock } {
  return {
    add: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    listenerCount: () => 0,
    name: 'notification-dispatch',
  } as unknown as Queue & {
    add: jest.Mock;
  };
}

function service(
  prisma: FakePrisma,
  delivery: EmailDeliveryService,
  queue?: Queue,
): NotificationsService {
  return new NotificationsService(
    prisma as unknown as PrismaService,
    delivery,
    queue,
  );
}

describe('NotificationsService.notify', () => {
  it('persists the row before enqueueing delivery', async () => {
    const prisma = fakePrisma();
    const delivery = fakeDelivery();
    const queue = fakeQueue();
    prisma.notification.create.mockResolvedValue({ id: 'n1' });

    await service(prisma, delivery, queue).notify({
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
      JOB_NAMES.notificationDispatch,
      { notificationId: 'n1' },
      expect.objectContaining({
        jobId: 'notification:n1',
        attempts: 5,
      }),
    );
    // The worker owns delivery; the request path does not call the vendor.
    expect(delivery.sendNotification).not.toHaveBeenCalled();
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
      service(prisma, fakeDelivery(), queue).notify({
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
    const delivery = fakeDelivery();
    prisma.notification.create.mockResolvedValue({ id: 'n1' });
    prisma.notification.findUnique.mockResolvedValue(
      notificationRow({ template: 'CAMPAIGN_FUNDED', data: { campaignId: 'c1' } }),
    );
    prisma.notification.update.mockResolvedValue({});

    await service(prisma, delivery).notify({
      toUserId: 'u1',
      template: 'CAMPAIGN_FUNDED',
      data: { campaignId: 'c1' },
    });

    expect(delivery.sendNotification).toHaveBeenCalledWith({
      toUserId: 'u1',
      toEmail: 'amara@example.test',
      notificationId: 'n1',
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
    const delivery = fakeDelivery();
    prisma.notification.create.mockResolvedValue({ id: 'n1' });
    prisma.notification.findUnique.mockResolvedValue(
      notificationRow({ template: 'WAITLIST_CONVERSION', data: {} }),
    );
    prisma.notification.update.mockResolvedValue({});
    delivery.sendNotification.mockRejectedValue(new Error('vendor down'));

    await expect(
      service(prisma, delivery).notify({
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
    const delivery = fakeDelivery();
    prisma.notification.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ dispatchedAt: new Date() });

    await service(prisma, delivery).dispatch('missing');
    await service(prisma, delivery).dispatch('sent');

    expect(delivery.sendNotification).not.toHaveBeenCalled();
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('records the failure and rethrows so the worker retries', async () => {
    const prisma = fakePrisma();
    const delivery = fakeDelivery();
    prisma.notification.findUnique.mockResolvedValue(
      notificationRow({ template: 'WAITLIST_CONVERSION', data: {} }),
    );
    prisma.notification.update.mockResolvedValue({});
    delivery.sendNotification.mockRejectedValue(new Error('timeout'));

    await expect(service(prisma, delivery).dispatch('n1')).rejects.toThrow(
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

  it('suppresses delivery when the template preference is off', async () => {
    const prisma = fakePrisma();
    const delivery = fakeDelivery();
    const row = notificationRow({ template: 'CAMPAIGN_FUNDED' });
    row.user.notifyCreatorUpdates = false;
    prisma.notification.findUnique.mockResolvedValue(row);
    prisma.notification.update.mockResolvedValue({});

    await service(prisma, delivery).dispatch('n1');

    expect(delivery.sendNotification).not.toHaveBeenCalled();
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { suppressedAt: expect.any(Date) },
    });
  });

  it('suppresses delivery when the account email is unverified', async () => {
    const prisma = fakePrisma();
    const delivery = fakeDelivery();
    const row = notificationRow({ template: 'WAITLIST_CONVERSION' });
    row.user.emailVerifiedAt = null;
    prisma.notification.findUnique.mockResolvedValue(row);
    prisma.notification.update.mockResolvedValue({});

    await service(prisma, delivery).dispatch('n1');

    expect(delivery.sendNotification).not.toHaveBeenCalled();
    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { suppressedAt: expect.any(Date) } }),
    );
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

    const result = await service(prisma, fakeDelivery()).list('u1', {
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
      service(prisma, fakeDelivery()).markRead('u1', 'n2'),
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
      service(prisma, fakeDelivery()).markRead('u1', 'n1'),
    ).resolves.toEqual({ id: 'n1', readAt: '2026-10-22T12:00:00.000Z' });
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('marks every unread row for the signed-in user', async () => {
    const prisma = fakePrisma();
    prisma.notification.updateMany.mockResolvedValue({ count: 3 });

    await expect(
      service(prisma, fakeDelivery()).markAllRead('u1'),
    ).resolves.toEqual({ updated: 3 });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });
});
