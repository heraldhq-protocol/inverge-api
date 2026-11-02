import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { EmailWebhookService } from './email-webhook.service';

/**
 * Resend delivery events: delivered, bounced, complained, delayed and failed.
 *
 * The raw bytes are used for the Svix HMAC. A verified event is claimed by the
 * shared webhook inbox before it is applied, so a provider retry cannot apply a
 * status twice. `dispatchedAt`/`SENT` never means delivered; only this route
 * moves a delivery to `DELIVERED`.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class EmailWebhookController {
  constructor(private readonly webhooks: EmailWebhookService) {}

  @Post('resend')
  @HttpCode(200)
  @RateLimit('webhook')
  @ApiOperation({ summary: 'Receive and verify Resend delivery webhooks' })
  handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    const raw = req.rawBody?.toString('utf8');
    if (!raw) {
      throw new BadRequestException('Raw request body is required');
    }
    return this.webhooks.handle(raw, headers);
  }
}
