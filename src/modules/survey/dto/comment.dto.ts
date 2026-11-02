import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateCommentDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(2000) body!: string;

  @ApiPropertyOptional({ description: 'Reply to another comment (its id); omit for a top-level comment' })
  @IsOptional() @IsString() parentId?: string;
}

/**
 * Campaign discussions are flat in this release. A separate DTO keeps a
 * `parentId` from being accepted and silently ignored by the service.
 */
export class CreateCampaignCommentDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(2000) body!: string;
}

export class ListCommentsQueryDto {
  @ApiPropertyOptional({ default: 50, maximum: 100, description: 'Page size' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Opaque cursor from a previous page. Omitting it starts at page one.',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(2048)
  cursor?: string;
}

export class HighlightCommentDto {
  @ApiProperty({ description: 'Feature this comment in the idea comments section' })
  @IsBoolean()
  highlighted!: boolean;
}
