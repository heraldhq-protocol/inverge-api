import { NotFoundException } from '@nestjs/common';
import { CacheService } from '../../common/cache/cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { VerificationService } from '../kyc/verification.service';
import { CampaignsService } from './campaigns.service';

/**
 * `GET /campaigns/:id` is also the marketing campaign page's read.
 *
 * The rules asserted here are the ones that make it safe to expose: a public
 * campaign resolves by id or by its source idea's slug, a non-public campaign is
 * indistinguishable from an unknown one to anyone but its creator, and the
 * shared cache is only used for the anonymous projection.
 */
describe('CampaignsService.get', () => {
  const findUnique = jest.fn();
  const findFirst = jest.fn();
  const prisma = {
    campaign: { findFirst, findUnique },
  } as unknown as PrismaService;
  const verification = {} as unknown as VerificationService;

  function campaign(overrides: Record<string, unknown> = {}) {
    return {
      id: 'campaign-1',
      creatorId: 'creator-1',
      status: 'ACTIVE',
      targetAmount: 1000,
      totalRaised: 250,
      deadline: new Date('2026-12-01T00:00:00.000Z'),
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      taxonomyCategorySlug: 'technology',
      taxonomySubcategorySlug: 'apps',
      creator: {
        id: 'creator-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        creatorProfile: { displayName: 'Ada Obi', username: 'ada' },
      },
      idea: { slug: 'stock-tracker', title: 'Stock tracker' },
      milestones: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('reads a public campaign by id', async () => {
    // #given
    findUnique.mockResolvedValue(campaign());

    // #when
    const result = await new CampaignsService(prisma, verification).get('campaign-1');

    // #then
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'campaign-1' } }),
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      id: 'campaign-1',
      creator: { displayName: 'Ada Obi' },
      taxonomy: { category: 'technology', subcategory: 'apps' },
    });
  });

  it('resolves the source idea slug when no campaign id matches', async () => {
    // #given
    findUnique.mockResolvedValue(null);
    findFirst.mockResolvedValue(campaign());

    // #when
    const result = await new CampaignsService(prisma, verification).get('stock-tracker');

    // #then
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idea: { is: { slug: 'stock-tracker' } } },
      }),
    );
    expect(result).toMatchObject({ id: 'campaign-1' });
  });

  it('returns the same 404 for a draft and an unknown id to an anonymous caller', async () => {
    // #given
    findUnique.mockResolvedValueOnce(campaign({ status: 'DRAFT' }));
    const service = new CampaignsService(prisma, verification);

    // #when / #then
    await expect(service.get('campaign-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // #given
    findUnique.mockResolvedValue(null);
    findFirst.mockResolvedValue(null);

    // #when / #then
    await expect(service.get('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lets the creator read their own draft', async () => {
    // #given
    findUnique.mockResolvedValue(campaign({ status: 'DRAFT' }));

    // #when
    const result = await new CampaignsService(prisma, verification).get(
      'campaign-1',
      'creator-1',
    );

    // #then
    expect(result).toMatchObject({ id: 'campaign-1' });
  });

  it('does not resolve an in-review campaign for a different signed-in user', async () => {
    // #given
    findUnique.mockResolvedValue(campaign({ status: 'IN_REVIEW' }));

    // #when / #then
    await expect(
      new CampaignsService(prisma, verification).get('campaign-1', 'someone-else'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('caches the anonymous read under the requested id or slug', async () => {
    // #given
    findUnique.mockResolvedValue(null);
    findFirst.mockResolvedValue(campaign());
    const getOrSet = jest.fn(
      async (
        _namespace: string,
        _key: string,
        _ttl: number,
        loader: () => Promise<unknown>,
      ) => loader(),
    );
    const service = new CampaignsService(prisma, verification, {
      getOrSet,
    } as unknown as CacheService);

    // #when
    await service.get('stock-tracker');

    // #then
    expect(getOrSet).toHaveBeenCalledWith(
      'campaign',
      'stock-tracker',
      30,
      expect.any(Function),
    );
  });

  it('never serves a viewer-specific contribution projection from the shared cache', async () => {
    // #given
    findUnique.mockResolvedValue(campaign());
    const getOrSet = jest.fn();
    const service = new CampaignsService(prisma, verification, {
      getOrSet,
    } as unknown as CacheService);

    // #when
    await service.get('campaign-1', 'backer-1');

    // #then
    expect(getOrSet).not.toHaveBeenCalled();
  });
});
