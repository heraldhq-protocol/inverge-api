import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PageInfoDto } from '../../../common/http/dto/page-info.dto';
import {
  AnalyticsAccessSource,
  AnalyticsRequestStatus,
} from '../analytics-entitlements';

const ACCESS_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
const REQUEST_STATUSES = [
  'NONE',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'NOT_REQUIRED',
] as const;

export class AnalyticsAccessDto {
  @ApiProperty({ example: 'analytics.premium' })
  feature!: string;

  @ApiProperty()
  premium!: boolean;

  @ApiProperty({ enum: REQUEST_STATUSES })
  requestStatus!: AnalyticsRequestStatus;

  @ApiProperty({
    description:
      'True when the account may submit a new request. False while pending or approved.',
  })
  canRequest!: boolean;

  @ApiProperty({
    enum: ['REQUEST', 'ADMIN', 'PAID'],
    nullable: true,
    description: 'How the current grant was issued; null before any request.',
  })
  source!: AnalyticsAccessSource | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  requestedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: string | null;

  @ApiProperty({ enum: ['STARTER', 'TRUSTED', 'ESTABLISHED'] })
  creatorTier!: 'STARTER' | 'TRUSTED' | 'ESTABLISHED';
}

export class ListAnalyticsAccessRequestsQueryDto {
  @ApiPropertyOptional({ enum: ACCESS_STATUSES })
  @IsOptional()
  @IsIn(ACCESS_STATUSES)
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({ default: 24, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Opaque cursor from a previous page. Omitting it starts at page one.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  cursor?: string;
}

export class AdminAnalyticsAccessRequestDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  userId!: string;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  username!: string | null;

  @ApiProperty({ enum: ['STARTER', 'TRUSTED', 'ESTABLISHED'] })
  creatorTier!: 'STARTER' | 'TRUSTED' | 'ESTABLISHED';

  @ApiProperty({ enum: ACCESS_STATUSES })
  status!: 'PENDING' | 'APPROVED' | 'REJECTED';

  @ApiProperty({ enum: ['REQUEST', 'ADMIN', 'PAID'] })
  source!: AnalyticsAccessSource;

  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: string | null;
}

export class AdminAnalyticsAccessRequestListDto {
  @ApiProperty({ type: [AdminAnalyticsAccessRequestDto] })
  data!: AdminAnalyticsAccessRequestDto[];

  @ApiProperty({ type: PageInfoDto })
  page!: PageInfoDto;
}

export class DecideAnalyticsAccessRequestDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsIn(['APPROVED', 'REJECTED'])
  status!: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'Optional paid-through instant for an approval. Omit for access without expiry.',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
