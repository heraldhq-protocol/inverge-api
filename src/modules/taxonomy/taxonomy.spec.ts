import {
  TAXONOMY,
  type TaxonomyCategoryDefinition,
} from './taxonomy.data';
import {
  findTaxonomyCategory,
  findTaxonomySubcategory,
  resolveTaxonomyPair,
  toTaxonomyProjection,
} from './taxonomy';

describe('taxonomy', () => {
  describe('canonical list', () => {
    it('mirrors the 15-parent, 154-subcategory web taxonomy', () => {
      // #given the canonical definition
      const categories = TAXONOMY.length;
      const subcategories = TAXONOMY.reduce(
        (total, category) => total + category.subcategories.length,
        0,
      );

      // #then
      expect(categories).toBe(15);
      expect(subcategories).toBe(154);
    });

    it('has unique category slugs and unique category/subcategory pairs', () => {
      // #given
      const categorySlugs = new Set<string>();
      const pairSlugs = new Set<string>();

      // #when
      for (const category of TAXONOMY) {
        expect(categorySlugs.has(category.slug)).toBe(false);
        categorySlugs.add(category.slug);

        for (const subcategory of category.subcategories) {
          const pair = `${category.slug}/${subcategory.slug}`;
          expect(pairSlugs.has(pair)).toBe(false);
          pairSlugs.add(pair);
        }
      }
    });

    it('preserves product labels verbatim rather than normalising them', () => {
      // #given
      const theater = findTaxonomyCategory('theater');
      const fashion = findTaxonomySubcategory('fashion', 'ready-to-wear');
      const food = findTaxonomySubcategory('food', 'farmers-markets');

      // #then
      expect(theater?.label).toBe('Theater');
      expect(fashion?.label).toBe('Ready-to-wear');
      expect(food?.label).toBe("Farmer's Markets");
    });
  });

  describe('resolveTaxonomyPair', () => {
    it('accepts a parent with no child when the parent is the honest fit', () => {
      // #when
      const result = resolveTaxonomyPair('crafts', undefined);

      // #then
      expect(result).toEqual({
        ok: true,
        pair: { category: 'crafts', subcategory: null },
      });
    });

    it('accepts a child under its own parent', () => {
      // #when
      const result = resolveTaxonomyPair('food', 'farms');

      // #then
      expect(result).toEqual({
        ok: true,
        pair: { category: 'food', subcategory: 'farms' },
      });
    });

    it('rejects a child under the wrong parent', () => {
      // #when
      const result = resolveTaxonomyPair('art', 'farms');

      // #then
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({
        reason: expect.stringContaining('art'),
      });
    });

    it('rejects a child without a parent', () => {
      // #when
      const result = resolveTaxonomyPair(undefined, 'farms');

      // #then
      expect(result).toEqual({
        ok: false,
        reason: 'taxonomySubcategory requires taxonomyCategory',
      });
    });

    it('rejects an unknown parent', () => {
      // #when
      const result = resolveTaxonomyPair('not-a-category', undefined);

      // #then
      expect(result).toEqual({
        ok: false,
        reason: 'Unknown taxonomy category: not-a-category',
      });
    });

    it('treats an empty pair as unassigned', () => {
      // #when
      const result = resolveTaxonomyPair('', '  ');

      // #then
      expect(result).toEqual({ ok: true, pair: null });
    });
  });

  describe('toTaxonomyProjection', () => {
    it('returns the public pair shape for a stored assignment', () => {
      // #then
      expect(toTaxonomyProjection('technology', 'apps')).toEqual({
        category: 'technology',
        subcategory: 'apps',
      });
    });

    it('returns null rather than inventing a pair for unassigned data', () => {
      // #then
      expect(toTaxonomyProjection(null, null)).toBeNull();
      expect(toTaxonomyProjection('art', 'farms')).toBeNull();
    });
  });

  it('keeps the canonical type read-only at the boundary', () => {
    // #given a category node from the exported list
    const category: TaxonomyCategoryDefinition = TAXONOMY[0];

    // #then the definition is the same object the lookup returns
    expect(findTaxonomyCategory(category.slug)).toBe(category);
  });
});
