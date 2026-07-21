import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { KycService } from './kyc.service';

@ApiTags('kyc')
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get('status')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.kyc.status(user.id);
  }

  @Post('session')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  session(@CurrentUser() user: AuthenticatedUser) {
    return this.kyc.startSession(user.id);
  }

  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-kyc-signature') signature?: string,
  ) {
    const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});
    return this.kyc.handleWebhook(raw, signature);
  }
}
