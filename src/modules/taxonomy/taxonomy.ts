import {
  TAXONOMY,
  type TaxonomyCategoryDefinition,
  type TaxonomySubcategoryDefinition,
} from './taxonomy.data';

/** The persisted shape of a taxonomy assignment. */
export type TaxonomyPair = {
  category: string;
  subcategory: string | null;
};

const categoryBySlug = new Map<string, TaxonomyCategoryDefinition>();
const subcategoryByPair = new Map<string, TaxonomySubcategoryDefinition>();

for (const category of TAXONOMY) {
  if (categoryBySlug.has(category.slug)) {
    throw new Error(`Duplicate taxonomy category slug: ${category.slug}`);
  }
  categoryBySlug.set(category.slug, category);

  const labels = new Set<string>();
  for (const subcategory of category.subcategories) {
    if (labels.has(subcategory.label)) {
      throw new Error(
        `Duplicate taxonomy subcategory label in ${category.slug}: ${subcategory.label}`,
      );
    }
    labels.add(subcategory.label);

    const key = `${category.slug}/${subcategory.slug}`;
    if (subcategoryByPair.has(key)) {
      throw new Error(`Duplicate taxonomy subcategory: ${key}`);
    }
    subcategoryByPair.set(key, subcategory);
  }
}

/** Category slugs in canonical display order. */
export const TAXONOMY_CATEGORY_SLUGS: string[] = TAXONOMY.map(
  (category) => category.slug,
);

export function findTaxonomyCategory(
  slug: string,
): TaxonomyCategoryDefinition | null {
  return categoryBySlug.get(slug) ?? null;
}

export function findTaxonomySubcategory(
  categorySlug: string,
  subcategorySlug: string,
): TaxonomySubcategoryDefinition | null {
  return subcategoryByPair.get(`${categorySlug}/${subcategorySlug}`) ?? null;
}

export type TaxonomyPairResult =
  | { ok: true; pair: TaxonomyPair | null }
  | { ok: false; reason: string };

/**
 * Validate a category/subcategory pair against the canonical list.
 *
 * A subcategory is only meaningful under its own parent: `food/farms` is valid,
 * `art/farms` is not. An empty pair is valid and means "unassigned", because
 * D-038 keeps taxonomy nullable rather than forcing an unrelated parent.
 */
export function resolveTaxonomyPair(
  category?: string | null,
  subcategory?: string | null,
): TaxonomyPairResult {
  const categorySlug = category?.trim() || null;
  const subcategorySlug = subcategory?.trim() || null;

  if (!categorySlug && !subcategorySlug) return { ok: true, pair: null };
  if (!categorySlug) {
    return {
      ok: false,
      reason: 'taxonomySubcategory requires taxonomyCategory',
    };
  }
  if (!findTaxonomyCategory(categorySlug)) {
    return { ok: false, reason: `Unknown taxonomy category: ${categorySlug}` };
  }
  if (subcategorySlug && !findTaxonomySubcategory(categorySlug, subcategorySlug)) {
    return {
      ok: false,
      reason: `Unknown taxonomy subcategory "${subcategorySlug}" under "${categorySlug}"`,
    };
  }

  return {
    ok: true,
    pair: { category: categorySlug, subcategory: subcategorySlug },
  };
}

/** Project the stored slugs into the public `{ category, subcategory }` shape. */
export function toTaxonomyProjection(
  category?: string | null,
  subcategory?: string | null,
): TaxonomyPair | null {
  const resolved = resolveTaxonomyPair(category, subcategory);
  return resolved.ok ? resolved.pair : null;
}
