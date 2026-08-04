import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

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
