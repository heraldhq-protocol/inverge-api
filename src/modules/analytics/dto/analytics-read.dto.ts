import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INTERVALS = ['day', 'week', 'month'] as const;

export class AnalyticsRangeQueryDto {
  @ApiPropertyOptional({ example: '2026-09-25', description: 'Inclusive UTC day.' })
  @IsOptional()
  @Matches(DAY, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-24', description: 'Inclusive UTC day.' })
  @IsOptional()
  @Matches(DAY, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  @ApiPropertyOptional({ enum: INTERVALS, default: 'day' })
  @IsOptional()
  @IsIn(INTERVALS)
  interval?: 'day' | 'week' | 'month';
}

export class AnalyticsTotalsDto {
  @ApiProperty()
  views!: number;

  @ApiProperty()
  uniqueSessions!: number;

  @ApiProperty({
    description:
      'False when the range predates raw-event retention and the value is the sum of daily uniques.',
  })
  uniqueSessionsExact!: boolean;
}

export class AnalyticsSeriesPointDto {
  @ApiProperty({ example: '2026-10-24' })
  bucket!: string;

  @ApiProperty()
  views!: number;

  @ApiProperty({ description: 'Daily uniques summed into the bucket.' })
  uniqueSessions!: number;

  @ApiProperty()
  supportCount!: number;

  @ApiProperty()
  prePledgeCount!: number;

  @ApiProperty()
  uniqueActors!: number;
}

export class AnalyticsSourceDto {
  @ApiProperty({ enum: ['feed', 'search', 'direct', 'internal'] })
  source!: string;

  @ApiProperty()
  views!: number;

  @ApiProperty()
  uniqueSessions!: number;

  @ApiProperty({ nullable: true, description: 'Share of views; null for a zero total.' })
  sharePct!: number | null;
}

export class AnalyticsCountryDto {
  @ApiProperty({ example: 'NG' })
  countryCode!: string;

  @ApiProperty()
  views!: number;

  @ApiProperty()
  uniqueSessions!: number;

  @ApiProperty({ nullable: true })
  sharePct!: number | null;
}

export class IdeaValidationCountsDto {
  @ApiProperty()
  supporters!: number;

  @ApiProperty()
  prePledges!: number;

  @ApiProperty()
  feedbackCount!: number;

  @ApiProperty({ description: 'Mean rating on the 0-5 scale.' })
  feedbackScore!: number;

  @ApiProperty()
  commentCount!: number;

  @ApiProperty({
    description: 'Weighted estimated interest in USD; intent, never received funds.',
  })
  estimatedInterestUsd!: string;

  @ApiProperty({ nullable: true, description: 'Not modelled in Phase 1.' })
  follows!: number | null;

  @ApiProperty({ nullable: true, description: 'Not modelled in Phase 1.' })
  saves!: number | null;
}

export class IdeaValidationConversionDto {
  @ApiProperty({ nullable: true })
  viewToSupportPct!: number | null;

  @ApiProperty({ nullable: true })
  viewToFeedbackPct!: number | null;

  @ApiProperty({ nullable: true })
  viewToCommentPct!: number | null;
}

export class IdeaAnalyticsSummaryDto {
  @ApiProperty()
  ideaId!: string;

  @ApiProperty()
  from!: string;

  @ApiProperty()
  to!: string;

  @ApiProperty({ type: AnalyticsTotalsDto })
  totals!: AnalyticsTotalsDto;

  @ApiProperty({ type: IdeaValidationCountsDto })
  validation!: IdeaValidationCountsDto;

  @ApiProperty({ nullable: true, example: '2026-10-24' })
  lastAggregatedDay!: string | null;

  @ApiProperty()
  generatedAt!: string;
}

export class IdeaAnalyticsTimeseriesDto {
  @ApiProperty()
  ideaId!: string;

  @ApiProperty()
  from!: string;

  @ApiProperty()
  to!: string;

  @ApiProperty({ enum: INTERVALS })
  interval!: 'day' | 'week' | 'month';

  @ApiProperty({
    description: 'True because bucket uniques are daily uniques summed, not a distinct range count.',
  })
  uniqueSessionsIsSum!: boolean;

  @ApiProperty({ type: [AnalyticsSeriesPointDto] })
  points!: AnalyticsSeriesPointDto[];

  @ApiProperty()
  generatedAt!: string;
}

export class IdeaAnalyticsValidationDto {
  @ApiProperty()
  ideaId!: string;

  @ApiProperty()
  from!: string;

  @ApiProperty()
  to!: string;

  @ApiProperty({ type: IdeaValidationCountsDto })
  counts!: IdeaValidationCountsDto;

  @ApiProperty({
    type: IdeaValidationConversionDto,
    nullable: true,
    description: 'Premium-only; null for a basic entitlement.',
  })
  conversion!: IdeaValidationConversionDto | null;

  @ApiProperty()
  premium!: boolean;

  @ApiProperty()
  generatedAt!: string;
}

export class IdeaAnalyticsAcquisitionDto {
  @ApiProperty()
  ideaId!: string;

  @ApiProperty()
  from!: string;

  @ApiProperty()
  to!: string;

  @ApiProperty()
  totalViews!: number;

  @ApiProperty({ type: [AnalyticsSourceDto] })
  sources!: AnalyticsSourceDto[];

  @ApiProperty()
  premium!: boolean;

  @ApiProperty()
  generatedAt!: string;
}

export class IdeaAnalyticsGeographyDto {
  @ApiProperty()
  ideaId!: string;

  @ApiProperty()
  from!: string;

  @ApiProperty()
  to!: string;

  @ApiProperty()
  totalViews!: number;

  @ApiProperty({ type: [AnalyticsCountryDto] })
  countries!: AnalyticsCountryDto[];

  @ApiProperty({ description: 'True when the country list was capped.' })
  truncated!: boolean;

  @ApiProperty()
  premium!: boolean;

  @ApiProperty()
  generatedAt!: string;
}

export class CampaignConfirmedBackingDto {
  @ApiProperty()
  count!: number;

  @ApiProperty({ description: 'Indexed amount in USD.' })
  amountUsd!: string;

  @ApiProperty({ example: 'contribution_indexer' })
  source!: string;
}

export class CampaignFunnelCountsDto {
  @ApiProperty()
  stepStarted!: number;

  @ApiProperty()
  stepCompleted!: number;

  @ApiProperty()
  contributionStarted!: number;
}

export class CampaignAnalyticsSummaryDto {
  @ApiProperty()
  campaignId!: string;

  @ApiProperty()
  from!: string;

  @ApiProperty()
  to!: string;

  @ApiProperty({ type: AnalyticsTotalsDto })
  totals!: AnalyticsTotalsDto;

  @ApiProperty({ type: CampaignFunnelCountsDto })
  funnel!: CampaignFunnelCountsDto;

  @ApiProperty({ type: CampaignConfirmedBackingDto })
  confirmedBacking!: CampaignConfirmedBackingDto;

  @ApiProperty({ nullable: true })
  lastAggregatedDay!: string | null;

  @ApiProperty()
  generatedAt!: string;
}

export class CampaignAnalyticsFunnelDto {
  @ApiProperty()
  campaignId!: string;

  @ApiProperty()
  from!: string;

  @ApiProperty()
  to!: string;

  @ApiProperty()
  views!: number;

  @ApiProperty()
  uniqueSessions!: number;

  @ApiProperty()
  uniqueSessionsExact!: boolean;

  @ApiProperty()
  stepStarted!: number;

  @ApiProperty()
  stepCompleted!: number;

  @ApiProperty({ nullable: true })
  stepCompletionPct!: number | null;

  @ApiProperty()
  backingStarted!: number;

  @ApiProperty({ type: CampaignConfirmedBackingDto })
  confirmedBacking!: CampaignConfirmedBackingDto;

  @ApiProperty()
  premium!: boolean;

  @ApiProperty()
  generatedAt!: string;
}

export class AdminAnalyticsResourceDto {
  @ApiProperty({ enum: ['IDEA', 'CAMPAIGN', 'PAGE'] })
  resourceType!: string;

  @ApiProperty()
  views!: number;

  @ApiProperty({ description: 'Daily uniques summed across the range.' })
  uniqueSessions!: number;
}

export class AdminAnalyticsOverviewDto {
  @ApiProperty()
  from!: string;

  @ApiProperty()
  to!: string;

  @ApiProperty({ type: AnalyticsTotalsDto })
  totals!: AnalyticsTotalsDto;

  @ApiProperty({ type: [AdminAnalyticsResourceDto] })
  resources!: AdminAnalyticsResourceDto[];

  @ApiProperty({ nullable: true })
  lastAggregatedDay!: string | null;

  @ApiProperty()
  generatedAt!: string;
}
