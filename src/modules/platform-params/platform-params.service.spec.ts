import { PlatformParamsService } from './platform-params.service';

function setup(existingValue: unknown | undefined) {
  const prisma = {
    platformParam: {
      findUnique: jest.fn().mockResolvedValue(existingValue === undefined ? null : { key: 'k', value: existingValue }),
      upsert: jest.fn().mockImplementation(({ create, update }: any) => Promise.resolve({ key: 'k', ...create, ...update })),
    },
    platformParamAudit: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as any;
  return { svc: new PlatformParamsService(prisma), prisma };
}

describe('PlatformParamsService.set — audit (FR-904)', () => {
  it('writes an audit row when the value changes (old -> new + actor)', async () => {
    const { svc, prisma } = setup(5);
    await svc.set('boost.basic.priceUSD', 8, 'admin1');
    expect(prisma.platformParam.upsert).toHaveBeenCalled();
    expect(prisma.platformParamAudit.create).toHaveBeenCalledWith({
      data: { key: 'boost.basic.priceUSD', oldValue: 5, newValue: 8, changedBy: 'admin1' },
    });
  });

  it('does NOT audit when the value is unchanged (no-op edit)', async () => {
    const { svc, prisma } = setup(8);
    await svc.set('boost.basic.priceUSD', 8, 'admin1');
    expect(prisma.platformParam.upsert).toHaveBeenCalled(); // still upserts (updatedBy/updatedAt)
    expect(prisma.platformParamAudit.create).not.toHaveBeenCalled();
  });

  it('logs a first-ever set with no prior value', async () => {
    const { svc, prisma } = setup(undefined);
    await svc.set('new.key', 42, 'admin1');
    expect(prisma.platformParamAudit.create).toHaveBeenCalledWith({
      data: { key: 'new.key', oldValue: undefined, newValue: 42, changedBy: 'admin1' },
    });
  });

  it('audits structural (JSON) value changes', async () => {
    const { svc, prisma } = setup([{ id: 'EMAIL', weight: 0.25 }]);
    await svc.set('validation.pledgeTiers', [{ id: 'EMAIL', weight: 0.1 }], 'admin1');
    expect(prisma.platformParamAudit.create).toHaveBeenCalled();
  });
});

describe('PlatformParamsService.auditLog', () => {
  it('reads newest-first, filtered by key, capped at 500', async () => {
    const { svc, prisma } = setup(1);
    await svc.auditLog({ key: 'boost.basic.priceUSD', limit: 999, offset: 5 });
    expect(prisma.platformParamAudit.findMany).toHaveBeenCalledWith({
      where: { key: 'boost.basic.priceUSD' },
      orderBy: { changedAt: 'desc' },
      take: 500, // capped
      skip: 5,
    });
  });

  it('returns all keys when no filter is given', async () => {
    const { svc, prisma } = setup(1);
    await svc.auditLog();
    expect(prisma.platformParamAudit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, take: 100, skip: 0 }),
    );
  });
});

describe('PlatformParamsService snapshot', () => {
  function setupSnapshot() {
    const prisma = {
      platformParam: {
        findMany: jest.fn().mockResolvedValue([
          { key: 'a', value: 1 },
          { key: 'b', value: 2 },
        ]),
        findUnique: jest.fn().mockResolvedValue({ key: 'a', value: 1 }),
        upsert: jest.fn().mockResolvedValue({ key: 'a', value: 9 }),
      },
      platformParamAudit: {
        create: jest.fn().mockResolvedValue({}),
      },
    } as any;

    return { svc: new PlatformParamsService(prisma), prisma };
  }

  it('reads the table once for several keys in one request', async () => {
    const { svc, prisma } = setupSnapshot();

    expect(await svc.getNumber('a')).toBe(1);
    expect(await svc.getNumber('b')).toBe(2);
    expect(prisma.platformParam.findMany).toHaveBeenCalledTimes(1);
  });

  it('invalidates the snapshot after a write in this process', async () => {
    const { svc, prisma } = setupSnapshot();

    await svc.getAll();
    await svc.set('a', 9, 'admin1');
    await svc.getAll();

    expect(prisma.platformParam.findMany).toHaveBeenCalledTimes(2);
  });

  it('falls back when a key is absent', async () => {
    const { svc } = setupSnapshot();

    expect(await svc.getNumber('missing', 7)).toBe(7);
  });
});
