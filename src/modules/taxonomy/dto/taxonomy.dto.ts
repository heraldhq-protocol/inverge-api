import { ApiProperty } from '@nestjs/swagger';

export class TaxonomySubcategoryDto {
  @ApiProperty({ example: 'farms' })
  slug!: string;

  @ApiProperty({ example: 'Farms' })
  label!: string;

  @ApiProperty({
    description:
      'Public ideas currently assigned to this subcategory. Counts only ideas the public catalogue can list.',
  })
  publicIdeaCount!: number;
}

export class TaxonomyCategoryDto {
  @ApiProperty({ example: 'food' })
  slug!: string;

  @ApiProperty({ example: 'Food' })
  label!: string;

  @ApiProperty({
    description:
      'Public ideas currently assigned to this category, including ideas assigned only at the parent level.',
  })
  publicIdeaCount!: number;

  @ApiProperty({ type: [TaxonomySubcategoryDto] })
  subcategories!: TaxonomySubcategoryDto[];
}

export class TaxonomyResponseDto {
  @ApiProperty({ type: [TaxonomyCategoryDto] })
  data!: TaxonomyCategoryDto[];
}
