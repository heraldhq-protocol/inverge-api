import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Env } from '../../config/env.validation';
import { AdminGuard } from '../auth/guards/admin.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { KycService } from './kyc.service';
import { AmlScreenDto } from './dto/aml-screen.dto';
import { EligibilityQueryDto } from './dto/eligibility-query.dto';
import { StartSessionDto } from './dto/start-session.dto';

@ApiTags('kyc')
@Controller('kyc')
export class KycController {
  constructor(
    private readonly kyc: KycService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get('status')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.kyc.status(user.id);
  }

  // Start a hosted verification. Body picks the purpose (default idea-validation identity).
  @Post('session')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  session(@CurrentUser() user: AuthenticatedUser, @Body() dto: StartSessionDto) {
    return this.kyc.startSession(user.id, dto.purpose ?? 'IDEA_VALIDATION');
  }

  // Is the caller cleared for a purpose? Lets the web app gate actions before attempting them.
  @Get('eligibility')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  eligibility(@CurrentUser() user: AuthenticatedUser, @Query() q: EligibilityQueryDto) {
    return this.kyc.eligibility(user.id, q.purpose ?? 'IDEA_VALIDATION');
  }

  // Provider callback. Public; the adapter verifies the HMAC signature and the service
  // re-fetches the authoritative decision before applying any status change.
  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});
    return this.kyc.handleWebhook(raw, headers);
  }

  // Dev-only shortcut (KYC_PROVIDER=stub): simulates the provider completing a session so the
  // offline flow can be exercised end-to-end without a browser or real callback.
  //
  // F-01: this route approves identity without a signature, so it must not exist in
  // production even if a future provider selection change leaves the stub reachable.
  // A non-disclosing 404 is deliberate: an attacker cannot distinguish this route from
  // any other unknown path.
  @Get('dev-complete')
  devComplete(
    @Query('ref') ref: string,
    @Query('user') user: string,
    @Query('status') status?: string,
    @Query('aml') aml?: string,
  ) {
    if (
      this.config.get('NODE_ENV', { infer: true }) === 'production' ||
      this.config.get('KYC_PROVIDER', { infer: true }) !== 'stub'
    ) {
      throw new NotFoundException();
    }
    const body = JSON.stringify({
      providerRef: ref,
      vendor_data: user,
      status: status ?? 'VERIFIED',
      aml,
    });
    return this.kyc.handleWebhook(body, {});
  }

  // ── Admin (FR-901): AML re-screen + retained history ──────────────────────────────
  @Post('admin/aml-screen')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Standalone AML screen for a user (ongoing monitoring)' })
  @UseGuards(PrivyAuthGuard, AdminGuard)
  adminScreenAml(@Body() dto: AmlScreenDto) {
    const { userId, ...params } = dto;
    return this.kyc.screenAml(userId, params);
  }

  @Get('admin/aml/:userId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'AML screening history for a user (NFR-19 retained)' })
  @UseGuards(PrivyAuthGuard, AdminGuard)
  adminListScreenings(@Param('userId') userId: string) {
    return this.kyc.listScreenings(userId);
  }
}
