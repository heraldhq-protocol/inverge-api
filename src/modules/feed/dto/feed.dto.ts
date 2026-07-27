import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { IDEA_CATEGORIES } from '../../ideas/dto/idea.dto';

export const FEED_TYPES = ['ideas', 'campaigns', 'all'] as const;

export class FeedQueryDto {
  @ApiPropertyOptional({
    enum: FEED_TYPES,
    default: 'ideas',
    description:
      'Object type to rank. Phase 0 serves ideas; campaigns join the same ranked feed '
      + 'from Phase 1+ (the ranker is object-agnostic — see FeedObjectType).',
  })
  @IsOptional()
  @IsIn(FEED_TYPES)
  type?: (typeof FEED_TYPES)[number];

  @ApiPropertyOptional({ default: 25, maximum: 50, description: 'Page size' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  take?: number;

  @ApiPropertyOptional({
    description:
      'Comma-separated idea ids the client has already seen recently; excluded from this '
      + 'page (stateless "already seen" — the feed keeps no per-user seen store).',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200)
      : value,
  )
  @IsArray()
  @IsString({ each: true })
  excludeIds?: string[];

  @ApiPropertyOptional({ enum: IDEA_CATEGORIES, description: 'Optional hard category filter (Stage 1 retrieval)' })
  @IsOptional()
  @IsIn(IDEA_CATEGORIES)
  category?: (typeof IDEA_CATEGORIES)[number];
}

// PUT /me/interests — onboarding personalization capture. Explicit preferences take
// precedence over inferred behaviour in the feed's personalization multiplier.
export class UpdateInterestsDto {
  @ApiPropertyOptional({ enum: IDEA_CATEGORIES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(IDEA_CATEGORIES, { each: true })
  preferredCategories?: (typeof IDEA_CATEGORIES)[number][];

  @ApiPropertyOptional({ type: [String], description: 'Regions/origins of interest (incl. diaspora origin)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  preferredRegions?: string[];
}
