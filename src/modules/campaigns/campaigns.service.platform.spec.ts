import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { CampaignsService } from './campaigns.service';

/**
 * `GET /platform/summary` is the marketing homepage's only aggregate read.
 *
 * The assertions that matter are the ones the page would otherwise be tempted
 * to break: every counter is a database count (never a sum over transactional
 * rows), the idea counter is the same predicate as public discovery, and no
 * monetary value is in the payload.
 */
describe('CampaignsService.getPlatformSummary', () => {
  const ideaCount = jest.fn();
  const campaignCount = jest.fn();
  const prisma = {
    idea: { count: ideaCount },
    campaign: { count: campaignCount },
  } as unknown as PrismaService;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns the four public counters from indexed counts', async () => {
    // #given
    ideaCount.mockResolvedValue(128);
    campaignCount
      .mockResolvedValueOnce(12) // ACTIVE
      .mockResolvedValueOnce(34) // COMPLETED
      .mockResolvedValueOnce(58); // public total
    const service = new CampaignsService(prisma);

    // #when
    const summary = await service.getPlatformSummary();

    // #then
    expect(summary).toMatchObject({
      activeCampaigns: 12,
      completedCampaigns: 34,
      publishedIdeas: 128,
      totalCampaigns: 58,
    });
    expect(Date.parse(summary.asOf)).not.toBeNaN();
  });

  it('counts only ideas the public catalogue can list', async () => {
    // #given
    ideaCount.mockResolvedValue(0);
    campaignCount.mockResolvedValue(0);
    const service = new CampaignsService(prisma);

    // #when
    await service.getPlatformSummary();

    // #then
    expect(ideaCount).toHaveBeenCalledWith({
      where: {
        status: { in: ['VALIDATING', 'THRESHOLD_MET'] },
        discoverabilityTier: { in: ['DISCOVERABLE', 'FEATURED'] },
      },
    });
  });

  it('excludes non-public campaign states from the total', async () => {
    // #given
    ideaCount.mockResolvedValue(0);
    campaignCount.mockResolvedValue(0);
    const service = new CampaignsService(prisma);

    // #when
    await service.getPlatformSummary();

    // #then
    expect(campaignCount).toHaveBeenCalledWith({ where: { status: 'ACTIVE' } });
    expect(campaignCount).toHaveBeenCalledWith({
      where: { status: 'COMPLETED' },
    });
    expect(campaignCount).toHaveBeenCalledWith({
      where: { status: { in: ['ACTIVE', 'FUNDED', 'FAILED', 'COMPLETED'] } },
    });
  });

  it('never returns money or escrow fields', async () => {
    // #given
    ideaCount.mockResolvedValue(1);
    campaignCount.mockResolvedValue(1);
    const service = new CampaignsService(prisma);

    // #when
    const summary = await service.getPlatformSummary();

    // #then
    expect(Object.keys(summary).sort()).toEqual([
      'activeCampaigns',
      'completedCampaigns',
      'publishedIdeas',
      'totalCampaigns',
      'asOf',
    ].sort());
    expect(JSON.stringify(summary)).not.toMatch(/escrow|usd|held|released/i);
  });

  it('serves the counters from the shared platform cache when Redis is on', async () => {
    // #given
    const cached = {
      asOf: '2026-10-26T00:00:00.000Z',
      activeCampaigns: 2,
      completedCampaigns: 3,
      publishedIdeas: 5,
      totalCampaigns: 8,
    };
    const getOrSet = jest.fn().mockResolvedValue(cached);
    const service = new CampaignsService(prisma, {
      getOrSet,
    } as unknown as CacheService);

    // #when
    const summary = await service.getPlatformSummary();

    // #then
    expect(summary).toBe(cached);
    expect(getOrSet).toHaveBeenCalledWith(
      'platform',
      'summary',
      60,
      expect.any(Function),
    );
    expect(ideaCount).not.toHaveBeenCalled();
  });
});
