import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_INGEST_EVENTS } from '../analytics-ingest.service';

/**
 * One wire event. Presence and semantic checks live in the pure validator so a
 * single bad event is reported by index instead of failing the whole batch. The
 * class-validator rules here only reject a malformed JSON shape.
 */
export class WireAnalyticsEventDto {
  @ApiPropertyOptional({
    description: 'Idempotency key; required by the service for every event.',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  eventKey?: string;

  @ApiProperty({ example: 'idea_viewed' })
  @IsString()
  @MaxLength(64)
  name!: string;

  @ApiProperty({ example: '2026-10-25T12:00:00.000Z' })
  @IsString()
  @MaxLength(40)
  occurredAt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sessionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ideaId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  campaignId?: string;

  @ApiPropertyOptional({ enum: ['IDEA', 'CAMPAIGN', 'PAGE'] })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  resourceType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceId?: string;

  @ApiPropertyOptional({ enum: ['SUPPORT', 'PRE_PLEDGE'] })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  signalType?: string;

  @ApiPropertyOptional({ enum: ['feed', 'search', 'direct', 'internal'] })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  step?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  durationMs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  queryLength?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  resultCount?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  filterKeys?: string[];

  @ApiPropertyOptional({
    description: 'Decimal string. Reserved for domain-confirmed events.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  amountMinor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({ example: 'NG' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string;
}

export class IngestAnalyticsEventsDto {
  @ApiProperty({ type: [WireAnalyticsEventDto] })
  @IsArray()
  @ArrayMaxSize(MAX_INGEST_EVENTS)
  @ValidateNested({ each: true })
  @Type(() => WireAnalyticsEventDto)
  events!: WireAnalyticsEventDto[];
}

export class RejectedAnalyticsEventDto {
  @ApiProperty()
  index!: number;

  @ApiProperty()
  reason!: string;
}

export class AnalyticsIngestResponseDto {
  @ApiProperty()
  received!: number;

  @ApiProperty()
  accepted!: number;

  @ApiProperty({ description: 'Rows written inline; 0 when the batch was queued.' })
  persisted!: number;

  @ApiProperty({ description: 'Duplicate event keys skipped on an inline write.' })
  duplicates!: number;

  @ApiProperty()
  queued!: boolean;

  @ApiProperty({ type: [RejectedAnalyticsEventDto] })
  rejected!: RejectedAnalyticsEventDto[];
}
