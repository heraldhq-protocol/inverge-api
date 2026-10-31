import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';

export class CreatorLinkDto {
  @IsString()
  @Length(1, 50)
  label: string;

  @IsUrl()
  @Matches(/^https:\/\//i, { message: 'Links must use HTTPS protocol' })
  url: string;
}

export class UpdateCreatorProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 30)
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Username can only contain letters, numbers, underscores, and dashes' })
  username?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 50)
  displayName?: string;

  /**
   * Either an uploaded asset reference (`/api/media/<id>`) or an external
   * `https` image. An empty string clears the picture. Anything else - a
   * `javascript:` URL, a plain host, a guessed id shape - is rejected here, so
   * the stored column only ever holds something a renderer can vet.
   */
  @ApiPropertyOptional({
    description:
      'Uploaded asset reference (`/api/media/<id>`) or an https image URL; send an empty string to clear.',
  })
  @IsOptional()
  @IsString()
  @Length(0, 2048)
  @Matches(
    /^(?:https:\/\/\S+|\/api\/media\/[a-z0-9]{20,40})?$/i,
    {
      message:
        'Avatar must be an uploaded image reference or an https link to one.',
    },
  )
  avatarUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 280)
  bio?: string;

  @ApiPropertyOptional({ type: [CreatorLinkDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatorLinkDto)
  links?: CreatorLinkDto[];
}
