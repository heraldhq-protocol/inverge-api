import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

export class UpdateParamsDto {
  @ApiProperty({
    description: 'Map of platform param keys to new values (partial update).',
    example: { 'validation.minSupporters': 25, 'boost.featured.priceNGN': 25000 },
  })
  @IsObject()
  params!: Record<string, unknown>;
}
