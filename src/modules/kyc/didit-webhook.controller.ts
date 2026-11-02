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
import { VerificationService } from './verification.service';

/**
 * Canonical Didit destination endpoint: POST /api/v1/webhooks/didit
 *
 * The body is read from `req.rawBody`, never from the parsed `req.body`, so
 * X-Signature (exact bytes) and X-Signature-V2 (canonical JSON) verify against what
 * Didit actually sent. Signature and signed-body freshness are checked by the
 * verification domain before any state is touched.
 *
 * The legacy `/verification/webhook` and `/kyc/webhook` routes stay mounted for
 * existing destinations; all three call the same handler.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class DiditWebhookController {
  constructor(private readonly verification: VerificationService) {}

  @Post('didit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Receive and verify Didit webhook events' })
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    const raw = req.rawBody?.toString('utf8');
    if (!raw) {
      throw new BadRequestException('Raw request body is required');
    }
    return this.verification.handleWebhook(raw, headers);
  }
}
