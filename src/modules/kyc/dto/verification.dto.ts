import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { parseBooleanQuery } from '../../../common/http/boolean-query';

export class VerificationSessionDto {
  @ApiPropertyOptional({
    enum: ['IDEA_VALIDATION', 'CAMPAIGN_CREATOR', 'BACKER_THRESHOLD'],
    default: 'CAMPAIGN_CREATOR',
  })
  @IsOptional()
  @IsIn(['IDEA_VALIDATION', 'CAMPAIGN_CREATOR', 'BACKER_THRESHOLD'])
  purpose?: 'IDEA_VALIDATION' | 'CAMPAIGN_CREATOR' | 'BACKER_THRESHOLD';

  @ApiPropertyOptional({ enum: ['INDIVIDUAL', 'BUSINESS'], default: 'INDIVIDUAL' })
  @IsOptional()
  @IsIn(['INDIVIDUAL', 'BUSINESS'])
  subject?: 'INDIVIDUAL' | 'BUSINESS';
}

export class VerificationBusinessDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  legalName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  registrationNumber?: string;

  @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2 country of registration' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  businessType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(400)
  registeredAddress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  representativeName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  representativeRole?: string;
}

export class AccountTypeDto {
  @ApiProperty({ enum: ['INDIVIDUAL', 'BUSINESS'] })
  @IsIn(['INDIVIDUAL', 'BUSINESS'])
  accountType!: 'INDIVIDUAL' | 'BUSINESS';
}

export class ContributionAuthorizationDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  campaignId!: string;

  @ApiProperty({ description: 'Amount in USD, two decimals' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amountUsd!: number;
}

export class AdminCaseQueryDto {
  @ApiPropertyOptional({ enum: ['SESSION_CREATED', 'AWAITING_USER', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'DECLINED', 'ACTION_REQUIRED', 'EXPIRED', 'CANCELLED', 'ERROR'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ enum: ['NOT_ASSESSED', 'CLEAR', 'REVIEW', 'FLAGGED'] })
  @IsOptional()
  @IsString()
  risk?: string;

  @ApiPropertyOptional({ enum: ['INDIVIDUAL', 'BUSINESS'] })
  @IsOptional()
  @IsIn(['INDIVIDUAL', 'BUSINESS'])
  type?: 'INDIVIDUAL' | 'BUSINESS';

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(parseBooleanQuery)
  @IsBoolean()
  requiresReview?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ResolveRiskDto {
  @ApiProperty({ enum: ['CLEAR', 'CONFIRM_MATCH'] })
  @IsIn(['CLEAR', 'CONFIRM_MATCH'])
  decision!: 'CLEAR' | 'CONFIRM_MATCH';

  @ApiProperty({ description: 'Stable reason code, never free text' })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  reasonCode!: string;

  @ApiProperty({ description: 'Reviewer reasoning recorded in the audit trail' })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
