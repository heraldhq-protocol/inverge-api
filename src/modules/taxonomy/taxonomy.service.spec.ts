import { PrismaService } from '../../prisma/prisma.service';
import { TaxonomyService } from './taxonomy.service';

describe('TaxonomyService', () => {
  const findMany = jest.fn();
  const groupBy = jest.fn();
  const prisma = {
    taxonomyCategory: { findMany },
    idea: { groupBy },
  } as unknown as PrismaService;
  const service = new TaxonomyService(prisma);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns the seeded tree with live public idea counts', async () => {
    // #given two parents, one with two children
    findMany.mockResolvedValue([
      {
        slug: 'food',
        label: 'Food',
        sortOrder: 0,
        subcategories: [
          { slug: 'farms', label: 'Farms', sortOrder: 0 },
          { slug: 'restaurants', label: 'Restaurants', sortOrder: 1 },
        ],
      },
      {
        slug: 'technology',
        label: 'Technology',
        sortOrder: 1,
        subcategories: [{ slug: 'apps', label: 'Apps', sortOrder: 0 }],
      },
    ]);
    groupBy
      .mockResolvedValueOnce([
        { taxonomyCategorySlug: 'food', _count: 4 },
        { taxonomyCategorySlug: 'technology', _count: 2 },
      ])
      .mockResolvedValueOnce([
        {
          taxonomyCategorySlug: 'food',
          taxonomySubcategorySlug: 'farms',
          _count: 3,
        },
        {
          taxonomyCategorySlug: 'food',
          taxonomySubcategorySlug: 'restaurants',
          _count: 1,
        },
      ]);

    // #when
    const result = await service.tree();

    // #then
    expect(result.data).toEqual([
      {
        slug: 'food',
        label: 'Food',
        publicIdeaCount: 4,
        subcategories: [
          { slug: 'farms', label: 'Farms', publicIdeaCount: 3 },
          { slug: 'restaurants', label: 'Restaurants', publicIdeaCount: 1 },
        ],
      },
      {
        slug: 'technology',
        label: 'Technology',
        publicIdeaCount: 2,
        subcategories: [{ slug: 'apps', label: 'Apps', publicIdeaCount: 0 }],
      },
    ]);
  });

  it('keeps same-named children under different parents separate', async () => {
    // #given "events" exists under comics and theater
    findMany.mockResolvedValue([
      {
        slug: 'comics',
        label: 'Comics',
        sortOrder: 0,
        subcategories: [{ slug: 'events', label: 'Events', sortOrder: 0 }],
      },
      {
        slug: 'theater',
        label: 'Theater',
        sortOrder: 1,
        subcategories: [{ slug: 'events', label: 'Events', sortOrder: 0 }],
      },
    ]);
    groupBy
      .mockResolvedValueOnce([
        { taxonomyCategorySlug: 'comics', _count: 1 },
        { taxonomyCategorySlug: 'theater', _count: 2 },
      ])
      .mockResolvedValueOnce([
        {
          taxonomyCategorySlug: 'comics',
          taxonomySubcategorySlug: 'events',
          _count: 1,
        },
        {
          taxonomyCategorySlug: 'theater',
          taxonomySubcategorySlug: 'events',
          _count: 2,
        },
      ]);

    // #when
    const result = await service.tree();

    // #then
    expect(result.data[0].subcategories[0].publicIdeaCount).toBe(1);
    expect(result.data[1].subcategories[0].publicIdeaCount).toBe(2);
  });

  it('counts only ideas the public catalogue can list', async () => {
    // #given
    findMany.mockResolvedValue([]);
    groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    // #when
    await service.tree();

    // #then
    const firstCall = groupBy.mock.calls[0][0];
    expect(firstCall.where).toMatchObject({
      status: { in: ['VALIDATING', 'THRESHOLD_MET'] },
      discoverabilityTier: { in: ['DISCOVERABLE', 'FEATURED'] },
    });
  });
});
