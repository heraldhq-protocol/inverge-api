import { ConfigService } from '@nestjs/config';
import { Prisma, type EmailDeliveryStatus } from '../../generated/prisma/client';
import type { Env } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailDeliveryError, type EmailPort } from '../../ports/email/email.port';
import { EmailContextService } from './email-context.service';
import { EmailDeliveryService } from './email-delivery.service';

const USER_ID = 'user-1';
const EMAIL = 'ada@example.test';

function config(): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    EMAIL_DELIVERY_MAX_ATTEMPTS: 3,
    EMAIL_DELIVERY_STALE_SECONDS: 300,
    EMAIL_UNSUBSCRIBE_SECRET: 'unsubscribe-secret-at-least-32-characters',
    PUBLIC_API_URL: 'https://api.inverge.test',
    PUBLIC_APP_URL: 'https://inverge.test',
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
}

type DeliveryRow = {
  id: string;
  idempotencyKey: string;
  attempts: number;
  status: EmailDeliveryStatus;
  recipient: string;
};

function fakePrisma(options: {
  existing?: DeliveryRow;
  claimWins?: boolean;
  suppression?: string | null;
  subscription?: { email: string; status: string } | null;
  user?: { email: string | null; emailVerifiedAt: Date | null } | null;
  attempts?: number;
}) {
  const update = jest.fn().mockResolvedValue({});
  const claims = jest.fn().mockResolvedValue({ count: options.claimWins === false ? 0 : 1 });
  return {
    update,
    claims,
    emailDelivery: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (options.existing) {
          throw new Prisma.PrismaClientKnownRequestError('duplicate', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        return { attempts: 0, id: 'delivery-1', status: 'PENDING', ...data };
      }),
      findUnique: jest.fn().mockResolvedValue(options.existing ?? null),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ status: 'SENT' }),
      update,
      updateMany: claims,
      upsert: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
    },
    emailSuppression: {
      findUnique: jest
        .fn()
        .mockResolvedValue(options.suppression ? { reason: options.suppression } : null),
    },
    emailSubscription: {
      findUnique: jest.fn().mockResolvedValue(options.subscription ?? null),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.user === undefined
            ? { email: EMAIL, emailVerifiedAt: new Date() }
            : options.user,
        ),
    },
  };
}

function context(): EmailContextService {
  return {
    apiUrl: () => 'https://api.inverge.test',
    appUrl: () => 'https://inverge.test',
    preferencesUrl: () => 'https://inverge.test/d/settings',
    renderOptions: () => ({
      appUrl: 'https://inverge.test',
      companyAddress: 'Inverge, 1 Test Street',
      logoUrl: null,
      preferencesUrl: 'https://inverge.test/d/settings',
      supportEmail: 'support@inverge.test',
    }),
    unsubscribeUrl: (id: string) =>
      `https://api.inverge.test/api/v1/email/preferences/${id}.token`,
  } as unknown as EmailContextService;
}

function port(): jest.Mocked<EmailPort> {
  return { send: jest.fn().mockResolvedValue({ providerMessageId: 'provider-1' }) };
}

function make(
  prisma: ReturnType<typeof fakePrisma>,
  emailPort: jest.Mocked<EmailPort> = port(),
) {
  const service = new EmailDeliveryService(
    prisma as unknown as PrismaService,
    config(),
    context(),
    emailPort,
  );
  return { service, prisma, port: emailPort };
}

const transactional = {
  idempotencyKey: 'idea-published:idea-1',
  templateId: 'IDEA_PUBLISHED' as const,
  to: EMAIL,
  userId: USER_ID,
  variables: { ideaId: 'idea-1', ideaTitle: 'Solar cold chain' },
};

describe('EmailDeliveryService', () => {
  it('delivers the converted-idea campaign notification through the provider port', async () => {
    const prisma = fakePrisma({});
    const { port, service } = make(prisma);

    const result = await service.sendNotification({
      data: {
        campaignId: 'cmp1',
        campaignSummary: 'A shared solar cold room.',
        campaignTitle: 'Solar cold storage',
        firstName: 'Amara',
        ideaTitle: 'Solar cold storage',
      },
      dedupeKey: 'IDEA_CONVERTED_TO_CAMPAIGN:cmp1:user-1',
      notificationId: 'n1',
      template: 'IDEA_CONVERTED_TO_CAMPAIGN',
      toEmail: EMAIL,
      toUserId: USER_ID,
    });

    expect(result.status).toBe('sent');
    const sent = port.send.mock.calls[0][0];
    expect(sent.subject).toBe('An idea you supported is now a campaign');
    expect(sent.html).toContain('https://inverge.test/campaigns/cmp1');
    expect(sent.html).toContain('did not charge you');
    expect(sent.text).toContain('Review the campaign');
    expect(sent.idempotencyKey).toBe('notification/n1');
  });

  it('claims the row, renders, sends and records the provider id', async () => {
    const prisma = fakePrisma({});
    const { service, port } = make(prisma);

    const result = await service.deliver(transactional);

    expect(result).toEqual({
      status: 'sent',
      deliveryId: 'delivery-1',
      providerMessageId: 'provider-1',
    });
    expect(prisma.claims).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SENDING' }),
      }),
    );
    const message = port.send.mock.calls[0][0];
    expect(message.subject).toContain('Solar cold chain');
    expect(message.html).toContain('https://inverge.test/ideas/idea-1');
    expect(message.deliveryId).toBe('delivery-1');
    expect(prisma.claims).toHaveBeenLastCalledWith({
      where: {
        id: 'delivery-1',
        status: { in: ['PENDING', 'SENDING', 'DELAYED', 'FAILED'] },
      },
      data: expect.objectContaining({
        providerMessageId: 'provider-1',
        status: 'SENT',
      }),
    });
  });

  it('is a no-op for an already sent delivery', async () => {
    const prisma = fakePrisma({
      existing: {
        attempts: 1,
        id: 'delivery-1',
        idempotencyKey: transactional.idempotencyKey,
        recipient: EMAIL,
        status: 'SENT',
      },
    });
    const { service, port } = make(prisma);

    const result = await service.deliver(transactional);

    expect(result).toEqual({
      status: 'duplicate',
      deliveryId: 'delivery-1',
      deliveryStatus: 'SENT',
    });
    expect(port.send).not.toHaveBeenCalled();
  });

  it('does not send when another worker holds the claim', async () => {
    const prisma = fakePrisma({
      claimWins: false,
      existing: {
        attempts: 1,
        id: 'delivery-1',
        idempotencyKey: transactional.idempotencyKey,
        recipient: EMAIL,
        status: 'PENDING',
      },
    });
    const { service, port } = make(prisma);

    expect((await service.deliver(transactional)).status).toBe('duplicate');
    expect(port.send).not.toHaveBeenCalled();
  });

  it('stops after the bounded attempt count', async () => {
    const prisma = fakePrisma({
      existing: {
        attempts: 3,
        id: 'delivery-1',
        idempotencyKey: transactional.idempotencyKey,
        recipient: EMAIL,
        status: 'FAILED',
      },
    });
    const { service, port } = make(prisma);

    expect((await service.deliver(transactional)).status).toBe('exhausted');
    expect(port.send).not.toHaveBeenCalled();
  });

  it('records a provider failure and rethrows a safe error', async () => {
    const prisma = fakePrisma({});
    const failing = {
      send: jest.fn().mockRejectedValue(new EmailDeliveryError('Email provider request failed')),
    } as jest.Mocked<EmailPort>;
    const { service } = make(prisma, failing);

    await expect(service.deliver(transactional)).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(prisma.claims).toHaveBeenLastCalledWith({
      where: {
        id: 'delivery-1',
        status: { in: ['PENDING', 'SENDING', 'DELAYED'] },
      },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
  });

  it('does not regress a delivery a fast webhook already moved forward', async () => {
    const prisma = fakePrisma({});
    prisma.claims
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const { service } = make(prisma);

    const result = await service.deliver(transactional);

    expect(result.status).toBe('sent');
    expect(prisma.claims).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT' }),
      }),
    );
    // Correlation is still recorded without touching the terminal status.
    expect(prisma.claims).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        where: { id: 'delivery-1', providerMessageId: null },
      }),
    );
  });

  it('suppresses a hard-bounced address without calling the provider', async () => {
    const prisma = fakePrisma({ suppression: 'HARD_BOUNCE' });
    const { service, port } = make(prisma);

    const result = await service.deliver(transactional);

    expect(result).toEqual({
      status: 'suppressed',
      deliveryId: 'delivery-1',
      reason: 'HARD_BOUNCE',
    });
    expect(port.send).not.toHaveBeenCalled();
  });

  it('still sends transactional mail to an unsubscribed address', async () => {
    const prisma = fakePrisma({ suppression: 'UNSUBSCRIBED' });
    const { service, port } = make(prisma);

    expect((await service.deliver(transactional)).status).toBe('sent');
    expect(port.send).toHaveBeenCalled();
  });

  it('enforces editorial consent and a verified address for marketing', async () => {
    const noConsent = make(
      fakePrisma({
        subscription: null,
        user: { email: EMAIL, emailVerifiedAt: new Date() },
      }),
    );
    const editorial = {
      idempotencyKey: 'editorial:issue-1:user-1',
      templateId: 'IDEA_OF_THE_WEEK' as const,
      to: EMAIL,
      userId: USER_ID,
      variables: { ideaId: 'idea-1', ideaTitle: 'Solar cold chain', ideaSummary: 'Cold storage' },
    };

    const suppressed = await noConsent.service.deliver(editorial);
    expect(suppressed).toEqual({
      status: 'suppressed',
      deliveryId: 'delivery-1',
      reason: 'NOT_SUBSCRIBED',
    });
    expect(noConsent.port.send).not.toHaveBeenCalled();

    const unverified = make(
      fakePrisma({
        subscription: { email: EMAIL, status: 'SUBSCRIBED' },
        user: { email: EMAIL, emailVerifiedAt: null },
      }),
    );
    expect((await unverified.service.deliver(editorial)).status).toBe('suppressed');
  });

  it('sends marketing mail with a one-click unsubscribe header', async () => {
    const prisma = fakePrisma({
      subscription: { email: EMAIL, status: 'SUBSCRIBED' },
      user: { email: EMAIL, emailVerifiedAt: new Date() },
    });
    const { service, port } = make(prisma);

    const result = await service.deliver({
      idempotencyKey: 'editorial:issue-1:user-1',
      templateId: 'IDEA_OF_THE_WEEK',
      to: EMAIL,
      userId: USER_ID,
      variables: { ideaTitle: 'Solar cold chain', ideaSummary: 'Cold storage' },
    });

    expect(result.status).toBe('sent');
    const message = port.send.mock.calls[0][0];
    expect(message.listUnsubscribeUrl).toContain('/email/preferences/');
    expect(message.html).toContain('Unsubscribe');
  });

  it('rejects an invalid recipient before touching the database', async () => {
    const prisma = fakePrisma({});
    const { service } = make(prisma);

    await expect(
      service.deliver({ ...transactional, to: 'not-an-email' }),
    ).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(prisma.emailDelivery.create).not.toHaveBeenCalled();
  });
});
