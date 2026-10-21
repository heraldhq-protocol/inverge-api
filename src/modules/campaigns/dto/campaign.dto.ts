import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
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
import { parseBooleanQuery } from '../../../common/http/boolean-query';
import {
  DISCOVERY_MAX_PAGE_SIZE,
  DISCOVERY_PAGE_SIZE,
} from '../../../common/http/pagination';

export const CAMPAIGN_SORT_OPTIONS = [
  'closing-soon',
  'newest',
  'most-backed',
] as const;

export class ListCampaignsQueryDto {
  @ApiPropertyOptional({
    default: DISCOVERY_PAGE_SIZE,
    maximum: DISCOVERY_MAX_PAGE_SIZE,
    description: 'Page size. Discovery pages omit an exact total.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DISCOVERY_MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Opaque nextCursor from the previous page. Do not construct or edit it.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

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
  @Transform(parseBooleanQuery)
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
