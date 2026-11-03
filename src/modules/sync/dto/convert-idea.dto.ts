import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export const CAMPAIGN_TYPES = ['ALL_OR_NOTHING', 'FLEXIBLE_FUNDING'] as const;
export const TOKEN_TYPES = ['USDC', 'CNGN'] as const;

const DECIMAL_2DP = /^\d+(\.\d{1,2})?$/;

export class MilestoneInputDto {
  @ApiProperty() @IsString() @IsNotEmpty() title!: string;
  @ApiProperty() @IsString() deliverable!: string;

  @ApiProperty({ minimum: 0, maximum: 100, description: 'Tranche %; all must sum to 100' })
  @IsNumber()
  @Min(0)
  @Max(100)
  tranchePct!: number;

  @ApiProperty({ description: 'Immutable evidence definition (proof type + source)' })
  @IsObject()
  evidenceDefinition!: Record<string, unknown>;
}

export class ConvertIdeaDto {
  @ApiProperty({ enum: CAMPAIGN_TYPES })
  @IsIn(CAMPAIGN_TYPES)
  type!: (typeof CAMPAIGN_TYPES)[number];

  @ApiProperty({ enum: TOKEN_TYPES })
  @IsIn(TOKEN_TYPES)
  tokenType!: (typeof TOKEN_TYPES)[number];

  @ApiProperty({
    description: 'USDC target as an exact decimal string.',
    example: '5000.00',
  })
  @IsString()
  @Matches(DECIMAL_2DP, {
    message: 'targetAmount must be a non-negative decimal with at most 2dp',
  })
  targetAmount!: string;

  @ApiProperty({ description: 'ISO 8601 deadline' })
  @IsDateString()
  deadline!: string;

  @ApiPropertyOptional({ description: 'Working-capital tranche %, fixed at 20 (FR-503a)' })
  @IsOptional()
  @IsNumber()
  @IsIn([20])
  workingCapitalPct?: number;

  @ApiProperty({ type: [MilestoneInputDto], description: '2–6 milestones (FR-301)' })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => MilestoneInputDto)
  milestones!: MilestoneInputDto[];
}
