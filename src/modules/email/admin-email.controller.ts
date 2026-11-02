import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { EMAIL_TEMPLATE_IDS, emailTemplateCatalogue } from '../../common/email';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { AdminGuard } from '../auth/guards/admin.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { EditorialEmailService } from './editorial-email.service';

class PreviewEditorialDto {
  @ApiProperty({ enum: EMAIL_TEMPLATE_IDS })
  @IsIn(EMAIL_TEMPLATE_IDS)
  templateId!: string;

  @ApiProperty({
    type: Object,
    additionalProperties: true,
    description: 'Template variables. No recipient data is accepted or rendered.',
  })
  @IsObject()
  variables!: Record<string, unknown>;
}

class SendEditorialDto extends PreviewEditorialDto {
  @ApiProperty({
    description:
      'Stable issue id. Repeating a send with the same id and recipient is a no-op.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  issueId!: string;

  @ApiProperty({
    type: [String],
    description:
      'Explicit account ids. Every recipient must hold an active editorial subscription.',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  userIds!: string[];
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(PrivyAuthGuard, AdminGuard)
@RateLimit('admin')
@Controller('admin/email')
export class AdminEmailController {
  constructor(private readonly editorial: EditorialEmailService) {}

  @Get('templates')
  @ApiOperation({
    summary: 'List email templates, category and required variables',
  })
  templates() {
    return { data: emailTemplateCatalogue() };
  }

  @Post('editorial/preview')
  @ApiOperation({
    summary: 'Render an editorial template without sending',
    description:
      'Returns subject, HTML and plain text. It does not create a delivery row and cannot send.',
  })
  preview(@Body() dto: PreviewEditorialDto) {
    return this.editorial.preview(dto.templateId, dto.variables);
  }

  @Post('editorial/send')
  @ApiOperation({
    summary: 'Send one editorial issue to explicit accounts',
    description:
      'Refused unless EDITORIAL_EMAILS_ENABLED=true. Recipients without an active subscription or a verified address are suppressed, never silently subscribed.',
  })
  send(@Body() dto: SendEditorialDto) {
    return this.editorial.send(
      dto.templateId,
      dto.variables,
      dto.issueId,
      dto.userIds,
    );
  }
}
