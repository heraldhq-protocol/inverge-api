import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListUsersQueryDto {
  @ApiPropertyOptional({ description: 'Case-insensitive match on email or Privy DID' })
  @IsOptional() @IsString() query?: string;

  @ApiPropertyOptional({ enum: ['USER', 'ADMIN'] })
  @IsOptional() @IsIn(['USER', 'ADMIN']) role?: 'USER' | 'ADMIN';

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
