import { ApiProperty } from '@nestjs/swagger';

/** Envelope metadata shared by every cursor-paginated list. */
export class PageInfoDto {
  @ApiProperty({ example: 24 })
  limit!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Opaque cursor for the next page, or null at the end.',
  })
  nextCursor!: string | null;

  @ApiProperty()
  hasMore!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Only present when the route can answer it cheaply.',
  })
  total!: number | null;

  @ApiProperty({ enum: ['exact', 'estimated', 'omitted'] })
  totalKind!: 'exact' | 'estimated' | 'omitted';
}
