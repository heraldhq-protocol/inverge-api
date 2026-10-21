import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  IsNotEmpty,
  ValidateNested,
} from 'class-validator';
import { parseBooleanQuery } from '../../../common/http/boolean-query';

export const PLEDGE_CURRENCIES = ['USD', 'NGN'] as const;

export const IDEA_CATEGORIES = [
  'technology',
  'software',
  'fintech',
  'agritech',
  'healthtech',
  'cleantech',
  'edtech',
  'logistics',
  'e-commerce',
  'web3',
  'art',
  'comics',
  'crafts',
  'dance',
  'design',
  'fashion',
  'film',
  'food',
  'games',
  'journalism',
  'music',
  'photography',
  'publishing',
  'theater',
  'community',
  'other',
] as const;

// FR-270: a dated roadmap step. At least two are required, so the form cannot be
// answered with vague free text.
export class RoadmapStepDto {
  @ApiProperty({ description: 'ISO date (or period label) for this step' })
  @IsString() @IsNotEmpty() date!: string;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(280) description!: string;
}

export class CreateIdeaDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(140) title!: string;
  @ApiProperty() @IsString() @IsNotEmpty() problem!: string;
  @ApiProperty() @IsString() @IsNotEmpty() solution!: string;

  // FR-270 structured pitch — mandatory; free-text-only submission is not possible.
  @ApiProperty({ description: 'Who specifically has this problem (named user type, not "everyone")' })
  @IsString() @IsNotEmpty() targetUser!: string;

  @ApiProperty({ description: 'What the user does today and why it falls short' })
  @IsString() @IsNotEmpty() currentAlternative!: string;

  @ApiProperty({ description: 'Indicative breakdown of what the ask will buy (object or array)' })
  @IsObject() askBreakdown!: Record<string, unknown>;

  @ApiProperty({ type: [RoadmapStepDto], description: 'At least two dated roadmap steps' })
  @IsArray() @ArrayMinSize(2) @ValidateNested({ each: true }) @Type(() => RoadmapStepDto)
  roadmapSteps!: RoadmapStepDto[];

  @ApiProperty({ enum: IDEA_CATEGORIES })
  @IsIn(IDEA_CATEGORIES) category!: (typeof IDEA_CATEGORIES)[number];

  @ApiPropertyOptional({
    description: 'Creator-declared region/origin (e.g. "Lagos"). Feeds discovery '
      + 'personalization (region match / diaspora-origin) — never a validation metric.',
  })
  @IsOptional() @IsString() @MaxLength(60) region?: string;

  @ApiPropertyOptional({ description: 'Optional free-text roadmap summary' })
  @IsOptional() @IsString() roadmap?: string;

  @ApiProperty({ description: 'Intended ask amount (USD)' })
  @IsNumber()
  @IsPositive()
  askAmount!: number;

  @ApiPropertyOptional({
    description: 'Creator-declared expected pre-pledge minimum in USD (FR-204). '
      + 'The gate requires the weighted figure to clear max(platform floor, this).',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  creatorPrePledgeTarget?: number;

  @ApiPropertyOptional({ description: 'Cover image URL for image-led cards' })
  @IsOptional()
  @IsString()
  coverImageUrl?: string;

  @ApiPropertyOptional({ description: 'Risks and challenges section (P2 coaching context)' })
  @IsOptional()
  @IsString()
  risks?: string;

  @ApiPropertyOptional({ description: 'Rich text problem document' })
  @IsOptional()
  @IsObject()
  problemDoc?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Rich text solution document' })
  @IsOptional()
  @IsObject()
  solutionDoc?: Record<string, unknown>;
}

export class UpdateIdeaDto extends PartialType(CreateIdeaDto) {}

export class PrePledgeDto {
  @ApiProperty({ description: 'Intent amount — NO funds move (FR-202)' })
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional({
    enum: PLEDGE_CURRENCIES,
    default: 'USD',
    description: 'FR-210: USD default; NGN normalized to USD at the current fx rate.',
  })
  @IsOptional()
  @IsIn(PLEDGE_CURRENCIES)
  currency?: (typeof PLEDGE_CURRENCIES)[number];
}

export class ListIdeasQueryDto {
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;

  @ApiPropertyOptional({ description: 'If true, returns calling creator\'s own ideas (all statuses including DRAFT)' })
  @IsOptional()
  @Transform(parseBooleanQuery)
  @IsBoolean()
  mine?: boolean;
}

