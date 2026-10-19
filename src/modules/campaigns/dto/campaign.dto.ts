import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export const CAMPAIGN_SORT_OPTIONS = [
  'closing-soon',
  'newest',
  'most-backed',
  'most-delivered',
] as const;

export class ListCampaignsQueryDto {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  region?: string;

  @ApiPropertyOptional({ enum: CAMPAIGN_SORT_OPTIONS })
  @IsOptional()
  @IsIn(CAMPAIGN_SORT_OPTIONS)
  sort?: (typeof CAMPAIGN_SORT_OPTIONS)[number];

  @ApiPropertyOptional({ description: 'If true, returns calling creator\'s own campaigns (all statuses including DRAFT and IN_REVIEW)' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  mine?: boolean;
}

export class SubmitCampaignDto {
  @ApiPropertyOptional({
    description:
      'SUCCEEDED APPLICATION_FEE charge id (FR-311). Required when the campaign has not already linked one; re-submission after a change request reuses it.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  applicationFeeChargeId?: string;
}
