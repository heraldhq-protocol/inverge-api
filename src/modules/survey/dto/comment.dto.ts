import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCommentDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(2000) body!: string;

  @ApiPropertyOptional({ description: 'Reply to another comment (its id); omit for a top-level comment' })
  @IsOptional() @IsString() parentId?: string;
}

export class HighlightCommentDto {
  @ApiProperty({ description: 'Feature this comment in the idea comments section' })
  @IsBoolean()
  highlighted!: boolean;
}
