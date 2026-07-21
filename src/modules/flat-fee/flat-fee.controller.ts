import {
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { FlatFeeService } from './flat-fee.service';

@ApiTags('flat-fee')
@Controller('flat-fee')
export class FlatFeeController {
  constructor(private readonly svc: FlatFeeService) {}

  // Uses the raw request body for signature verification (enabled via rawBody in main.ts).
  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature?: string,
  ) {
    const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});
    return this.svc.handleWebhook(raw, signature);
  }
}
