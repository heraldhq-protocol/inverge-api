import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  IsNotEmpty,
} from 'class-validator';

export const PLEDGE_CURRENCIES = ['USD', 'NGN'] as const;

export class CreateIdeaDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(140) title!: string;
  @ApiProperty() @IsString() @IsNotEmpty() problem!: string;
  @ApiProperty() @IsString() @IsNotEmpty() solution!: string;
  @ApiProperty() @IsString() @IsNotEmpty() roadmap!: string;

  @ApiProperty({ description: 'Intended ask amount (USD)' })
  @IsNumber()
  @IsPositive()
  askAmount!: number;

  @ApiPropertyOptional({
    description: 'Creator-declared expected pre-pledge minimum in USD (FR-204). '
      + 'The gate requires the weighted figure to clear max(platform floor, this).',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  creatorPrePledgeTarget?: number;
}

export class UpdateIdeaDto extends PartialType(CreateIdeaDto) {}

export class PrePledgeDto {
  @ApiProperty({ description: 'Intent amount — NO funds move (FR-202)' })
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional({
    enum: PLEDGE_CURRENCIES,
    default: 'USD',
    description: 'FR-210: USD default; NGN normalized to USD at the current fx rate.',
  })
  @IsOptional()
  @IsIn(PLEDGE_CURRENCIES)
  currency?: (typeof PLEDGE_CURRENCIES)[number];
}

export class FeedbackDto {
  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;
}

export class ListIdeasQueryDto {
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
