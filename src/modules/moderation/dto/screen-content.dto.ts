import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const MODERATABLE_KINDS = ['idea', 'campaign'] as const;

export class ScreenContentDto {
  @ApiProperty({ enum: MODERATABLE_KINDS })
  @IsIn(MODERATABLE_KINDS)
  kind!: (typeof MODERATABLE_KINDS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiProperty({ description: 'Concatenated submission text to screen' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  text!: string;
}
