import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { IDEA_CATEGORIES } from '../../ideas/dto/idea.dto';

export const SETTINGS_FEED_REGIONS = [
  'global',
  'africa',
  'west-africa',
] as const;
export type SettingsFeedRegion = (typeof SETTINGS_FEED_REGIONS)[number];

export const SETTINGS_REQUEST_TYPES = [
  'DATA_EXPORT',
  'ACCOUNT_DELETION',
] as const;
export type SettingsRequestType = (typeof SETTINGS_REQUEST_TYPES)[number];

export class UpdateFeedSettingsDto {
  @ApiProperty({
    enum: IDEA_CATEGORIES,
    isArray: true,
    description: 'Idea categories to prioritise in the discovery feed.',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(IDEA_CATEGORIES, { each: true })
  topics!: (typeof IDEA_CATEGORIES)[number][];

  @ApiProperty({
    enum: SETTINGS_FEED_REGIONS,
    description:
      'Broad region preference. Global means no region tilt; it never filters ideas out.',
  })
  @IsIn(SETTINGS_FEED_REGIONS)
  region!: SettingsFeedRegion;

  @ApiProperty({
    description:
      'When false, paid placements are not injected into this account’s feed.',
  })
  @IsBoolean()
  showPromoted!: boolean;
}

export class UpdateNotificationSettingsDto {
  @ApiProperty()
  @IsBoolean()
  emailUpdates!: boolean;

  @ApiProperty()
  @IsBoolean()
  milestoneReviews!: boolean;

  @ApiProperty()
  @IsBoolean()
  creatorUpdates!: boolean;

  @ApiProperty()
  @IsBoolean()
  discoveryDigest!: boolean;
}

export class CreateAccountRequestDto {
  @ApiProperty({ enum: SETTINGS_REQUEST_TYPES })
  @IsIn(SETTINGS_REQUEST_TYPES)
  type!: SettingsRequestType;

  @ApiPropertyOptional({
    description:
      'Optional context for the support team. Never used for authentication.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
