import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { TAXONOMY_CATEGORY_SLUGS } from '../../taxonomy/taxonomy';

/**
 * Request shapes for the creator's campaign draft and its escrow deployment.
 *
 * Only authored content is accepted here. Deployment status, fee status, cluster,
 * programme id, PDAs, mint, rent and transaction signatures are server-derived;
 * `forbidNonWhitelisted` turns any attempt to set them into a 400 rather than a
 * silently ignored field.
 */

const DECIMAL_2DP = /^\d+(\.\d{1,2})?$/;
const PERCENT_2DP = /^\d{1,3}(\.\d{1,2})?$/;
/** The initial tranche is fixed at 20% of the target (FR-503a). */
const WORKING_CAPITAL_PERCENT = /^20(\.0{1,2})?$/;

export class CampaignMediaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string;

  @ApiProperty({ enum: ['image', 'video'] })
  @IsIn(['image', 'video'])
  kind!: 'image' | 'video';

  @ApiProperty({ description: 'An https URL or a same-origin asset path.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  src!: string;

  @ApiProperty({ description: 'Alt text. Required: it is what a screen reader reads.' })
  @IsString()
  @MinLength(3)
  @MaxLength(280)
  alt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(280)
  caption?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  poster?: string;
}

export class UseOfFundsLineDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @ApiProperty({ description: 'USD amount as an exact decimal string.', example: '250.00' })
  @IsString()
  @Matches(DECIMAL_2DP, { message: 'amount must be a non-negative decimal with at most 2dp' })
  amount!: string;
}

export class CampaignMilestoneDraftDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  deliverable!: string;

  @ApiProperty({
    description:
      'Share of the amount left after the fixed 20% working-capital tranche, e.g. "30" or "12.5". All milestone weights must total exactly 100% on their own.',
  })
  @IsString()
  @Matches(PERCENT_2DP)
  allocationPercent!: string;

  @ApiProperty({ description: 'The immutable evidence definition (FR-302).' })
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  evidence!: string;

  @ApiPropertyOptional({ description: 'ISO date for the on-chain milestone deadline.' })
  @IsOptional()
  @IsISO8601()
  expectedAt?: string;
}

export class CreateCampaignDraftDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(90)
  title!: string;

  @ApiProperty()
  @IsString()
  @MinLength(20)
  @MaxLength(320)
  summary!: string;

  @ApiPropertyOptional({ enum: TAXONOMY_CATEGORY_SLUGS })
  @IsOptional()
  @IsIn(TAXONOMY_CATEGORY_SLUGS)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  subcategory?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  location!: string;

  @ApiProperty()
  @IsString()
  @MinLength(20)
  @MaxLength(4000)
  problem!: string;

  @ApiProperty()
  @IsString()
  @MinLength(20)
  @MaxLength(4000)
  solution!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  beneficiaries!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  eligibility?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  risks?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  failurePlan?: string;

  @ApiProperty({ description: 'USDC target as an exact decimal string.', example: '5000.00' })
  @IsString()
  @Matches(DECIMAL_2DP, { message: 'targetAmount must be a non-negative decimal with at most 2dp' })
  targetAmount!: string;

  @ApiProperty({ description: 'ISO 8601 funding deadline.' })
  @IsISO8601()
  deadline!: string;

  @ApiPropertyOptional({ enum: ['USDC', 'CNGN'] })
  @IsOptional()
  @IsIn(['USDC', 'CNGN'])
  tokenType?: 'USDC' | 'CNGN';

  @ApiProperty({
    description:
      'The initial working-capital tranche: exactly 20% of the target, released at funding close. Milestone weights divide what remains and total 100% on their own.',
  })
  @IsString()
  @Matches(PERCENT_2DP)
  @Matches(WORKING_CAPITAL_PERCENT, {
    message: 'workingCapitalPercent must be exactly 20 (FR-503a)',
  })
  workingCapitalPercent!: string;

  @ApiProperty({ description: 'Objection window in days. The programme fixes it at 7.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  objectionWindowDays!: number;

  @ApiProperty({ type: [CampaignMilestoneDraftDto] })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => CampaignMilestoneDraftDto)
  milestones!: CampaignMilestoneDraftDto[];

  @ApiPropertyOptional({ type: [UseOfFundsLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => UseOfFundsLineDto)
  useOfFunds?: UseOfFundsLineDto[];

  @ApiPropertyOptional({ type: [CampaignMediaDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CampaignMediaDto)
  heroMedia?: CampaignMediaDto[];

  @ApiPropertyOptional({ type: [CampaignMediaDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CampaignMediaDto)
  storyMedia?: CampaignMediaDto[];

  @ApiPropertyOptional({
    description:
      'Reward tiers as authored by the creator. Stored as a JSON projection; fulfilment semantics are validated by the web layer and reviewed before publication.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsObject({ each: true })
  rewardTiers?: Record<string, unknown>[];
}

/**
 * A save carries the version it read. `version` is required so a client cannot
 * accidentally opt out of optimistic concurrency: a stale tab gets a 409 instead
 * of overwriting newer edits.
 */
export class UpdateCampaignDraftDto extends PartialType(CreateCampaignDraftDto) {
  @ApiProperty({ description: 'The draftVersion returned by the last successful read or write.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;
}

export class PrepareDeploymentDto {
  @ApiProperty({
    description:
      'Explicit acceptance of the campaign terms being committed on-chain. Recorded separately from the wallet signature.',
  })
  @IsBoolean()
  acceptTerms!: boolean;
}

export class SubmitDeploymentDto {
  @ApiProperty({
    description: 'Base58 transaction signature returned by the wallet after sending.',
  })
  @IsString()
  @MinLength(64)
  @MaxLength(100)
  @Matches(/^[1-9A-HJ-NP-Za-km-z]+$/, { message: 'signature must be base58' })
  signature!: string;

  @ApiPropertyOptional({
    description:
      'Deployment attempt the signature belongs to. Supplying a different attempt is rejected rather than applied.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  attemptId?: string;
}
