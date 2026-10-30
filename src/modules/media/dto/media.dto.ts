import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Request shapes for the media endpoints.
 *
 * `contentType` and `byteSize` are the browser's claim. They are used only to
 * choose an object key and to refuse an obviously oversized upload before an
 * expensive round trip; the verified values are read back from storage when the
 * upload completes. A caller cannot assert a category, an object key, a bucket or
 * an owner id.
 */

/** Mirrors the Prisma `MediaAssetCategory` enum. */
export const MEDIA_ASSET_CATEGORIES = [
  'AVATAR',
  'IDEA_COVER',
  'IDEA_GALLERY',
  'CAMPAIGN_COVER',
  'CAMPAIGN_HERO',
  'CAMPAIGN_STORY',
  'REWARD',
  'OTHER',
] as const;

export type MediaAssetCategoryName = (typeof MEDIA_ASSET_CATEGORIES)[number];

export class CreateMediaUploadDto {
  @ApiProperty({
    description:
      'Declared MIME type. Must be in the configured image allowlist; the bytes are verified at completion.',
    example: 'image/jpeg',
  })
  @IsString()
  @MaxLength(120)
  contentType!: string;

  @ApiProperty({ description: 'Declared byte length.', example: 482_311 })
  @IsInt()
  @Min(1)
  @Max(200 * 1024 * 1024)
  byteSize!: number;

  @ApiPropertyOptional({ enum: MEDIA_ASSET_CATEGORIES, default: 'OTHER' })
  @IsOptional()
  @IsIn(MEDIA_ASSET_CATEGORIES)
  category?: MediaAssetCategoryName;

  @ApiPropertyOptional({ description: 'Original filename, for display only.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayName?: string;

  @ApiPropertyOptional({ description: 'Alt text. Required for meaningful images.' })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  altText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(280)
  caption?: string;
}

export class UpdateMediaAssetDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(280)
  altText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(280)
  caption?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  displayName?: string;
}
