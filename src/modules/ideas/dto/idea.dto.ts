import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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

export class CreateIdeaDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(140) title!: string;
  @ApiProperty() @IsString() @IsNotEmpty() problem!: string;
  @ApiProperty() @IsString() @IsNotEmpty() solution!: string;
  @ApiProperty() @IsString() @IsNotEmpty() roadmap!: string;

  @ApiProperty({ description: 'Intended ask amount (USD)' })
  @IsNumber()
  @IsPositive()
  askAmount!: number;
}

export class UpdateIdeaDto extends PartialType(CreateIdeaDto) {}

export class PrePledgeDto {
  @ApiProperty({ description: 'Intent amount — NO funds move (FR-202)' })
  @IsNumber()
  @IsPositive()
  amount!: number;
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
