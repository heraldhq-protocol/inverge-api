import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CAMPAIGN_REVIEW_ACTIONS,
  type CampaignReviewActionValue,
} from '../campaign-review.rules';

export const CAMPAIGN_REVIEW_STATUS_FILTERS = [
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'REJECTED',
  'NOT_SUBMITTED',
  'ALL',
] as const;

export type CampaignReviewStatusFilter =
  (typeof CAMPAIGN_REVIEW_STATUS_FILTERS)[number];

export class ListCampaignReviewQueueDto {
  @ApiPropertyOptional({
    enum: CAMPAIGN_REVIEW_STATUS_FILTERS,
    default: 'IN_REVIEW',
    description: 'Review state to list; ALL returns every campaign.',
  })
  @IsOptional()
  @IsIn(CAMPAIGN_REVIEW_STATUS_FILTERS)
  reviewStatus?: CampaignReviewStatusFilter;

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
}

export class DecideCampaignReviewDto {
  @ApiProperty({ enum: CAMPAIGN_REVIEW_ACTIONS })
  @IsIn(CAMPAIGN_REVIEW_ACTIONS)
  action!: CampaignReviewActionValue;

  @ApiPropertyOptional({
    description:
      'Required (20-2000 characters) for REQUEST_CHANGES and REJECT; optional note for APPROVE.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
