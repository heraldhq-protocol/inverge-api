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
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export const CAMPAIGN_TYPES = ['ALL_OR_NOTHING', 'FLEXIBLE_FUNDING'] as const;
export const TOKEN_TYPES = ['USDC', 'CNGN'] as const;

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

  @ApiProperty() @IsNumber() @IsPositive() targetAmount!: number;

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
