import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsPositive, Max, Min } from 'class-validator';

// FR-206/904: configure Basic/Featured boost pricing (USD) + durations. All fields
// optional — only the provided ones are changed (and audited).
export class BoostPricesDto {
  @ApiPropertyOptional({ description: 'Basic boost price (USD)' })
  @IsOptional() @IsNumber() @IsPositive() basicPriceUSD?: number;

  @ApiPropertyOptional({ description: 'Featured boost price (USD)' })
  @IsOptional() @IsNumber() @IsPositive() featuredPriceUSD?: number;

  @ApiPropertyOptional({ description: 'Basic boost duration (days)' })
  @IsOptional() @IsInt() @Min(1) @Max(365) basicDurationDays?: number;

  @ApiPropertyOptional({ description: 'Featured boost duration (days)' })
  @IsOptional() @IsInt() @Min(1) @Max(365) featuredDurationDays?: number;
}
