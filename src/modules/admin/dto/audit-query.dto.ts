import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class AuditQueryDto {
  @ApiPropertyOptional({ description: 'Filter to one param key' })
  @IsOptional() @IsString() key?: string;

  @ApiPropertyOptional({ default: 100, maximum: 500 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
