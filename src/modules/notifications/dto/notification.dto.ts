import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { parseBooleanQuery } from '../../../common/http/boolean-query';
import { PageInfoDto } from '../../../common/http/dto/page-info.dto';

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({ default: 24, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Opaque cursor from a previous page. Omitting it starts at page one.',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(2048)
  cursor?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(parseBooleanQuery)
  @IsBoolean()
  unreadOnly?: boolean;
}

export class NotificationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'WAITLIST_CONVERSION' })
  template!: string;

  @ApiProperty({
    type: Object,
    nullable: true,
    additionalProperties: true,
    description: 'Template parameters. Never contains secrets or free text.',
  })
  data!: Record<string, unknown> | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

export class NotificationListDto {
  @ApiProperty({ type: [NotificationDto] })
  data!: NotificationDto[];

  @ApiProperty({ type: PageInfoDto })
  page!: PageInfoDto;
}

export class NotificationReadDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt!: string | null;
}

export class MarkAllNotificationsReadDto {
  @ApiProperty({ description: 'Rows moved from unread to read.' })
  updated!: number;
}

export class UnreadNotificationCountDto {
  @ApiProperty()
  count!: number;
}
