import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxonomyResponseDto } from './dto/taxonomy.dto';

// The same visibility rule as `GET /ideas`: a validating or threshold-met idea
// that the catalogue can actually surface. Draft, converted and link-only ideas
// are not counted, so a category chip cannot advertise an unlisted idea.
const PUBLIC_IDEA_FILTER: Prisma.IdeaWhereInput = {
  status: { in: ['VALIDATING', 'THRESHOLD_MET'] },
  discoverabilityTier: { in: ['DISCOVERABLE', 'FEATURED'] },
};

/**
 * The browse taxonomy.
 *
 * Labels come from the seeded reference tables so an operator can correct a label
 * without a deploy; the canonical slug list still lives in `taxonomy.data.ts` and
 * is what write validation uses. Counts are derived on every read, never stored
 * (FR-203): a stored counter would drift after a status change or a takedown.
 */
@Injectable()
export class TaxonomyService {
  constructor(private readonly prisma: PrismaService) {}

  async tree(): Promise<TaxonomyResponseDto> {
    const [categories, categoryCounts, subcategoryCounts] = await Promise.all([
      this.prisma.taxonomyCategory.findMany({
        orderBy: { sortOrder: 'asc' },
        include: { subcategories: { orderBy: { sortOrder: 'asc' } } },
      }),
      this.prisma.idea.groupBy({
        by: ['taxonomyCategorySlug'],
        where: {
          ...PUBLIC_IDEA_FILTER,
          taxonomyCategorySlug: { not: null },
        },
        _count: true,
      }),
      this.prisma.idea.groupBy({
        by: ['taxonomyCategorySlug', 'taxonomySubcategorySlug'],
        where: {
          ...PUBLIC_IDEA_FILTER,
          taxonomySubcategorySlug: { not: null },
        },
        _count: true,
      }),
    ]);

    const categoryCountBySlug = new Map(
      categoryCounts
        .filter((row) => row.taxonomyCategorySlug !== null)
        .map((row) => [row.taxonomyCategorySlug as string, row._count]),
    );
    const subcategoryCountByPair = new Map(
      subcategoryCounts
        .filter(
          (row) =>
            row.taxonomyCategorySlug !== null &&
            row.taxonomySubcategorySlug !== null,
        )
        .map((row) => [
          `${row.taxonomyCategorySlug}/${row.taxonomySubcategorySlug}`,
          row._count,
        ]),
    );

    return {
      data: categories.map((category) => ({
        slug: category.slug,
        label: category.label,
        publicIdeaCount: categoryCountBySlug.get(category.slug) ?? 0,
        subcategories: category.subcategories.map((subcategory) => ({
          slug: subcategory.slug,
          label: subcategory.label,
          publicIdeaCount:
            subcategoryCountByPair.get(
              `${category.slug}/${subcategory.slug}`,
            ) ?? 0,
        })),
      })),
    };
  }
}
