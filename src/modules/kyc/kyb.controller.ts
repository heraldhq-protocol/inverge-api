import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { AdminGuard } from '../auth/guards/admin.guard';
import { EmailVerifiedGuard } from '../auth/guards/email-verified.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { KycService } from './kyc.service';
import { AmlScreenDto } from './dto/aml-screen.dto';
import { StartBusinessDto } from './dto/start-business.dto';

// Business (KYB) surface — a company registers to create and back campaigns. Shares the KYC
// provider + the /kyc/webhook callback; the service routes a KYB decision to the business.
@ApiTags('kyb')
@Controller('kyb')
export class KybController {
  constructor(private readonly kyc: KycService) {}

  @Get('status')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.kyc.businessStatus(user.id);
  }

  // Register/update the business and start KYB verification.
  @Post('session')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard, EmailVerifiedGuard)
  session(@CurrentUser() user: AuthenticatedUser, @Body() dto: StartBusinessDto) {
    return this.kyc.startBusinessSession(user.id, dto);
  }

  // Is the business cleared to create/back campaigns (KYB VERIFIED + AML CLEAR)?
  @Get('eligibility')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  eligibility(@CurrentUser() user: AuthenticatedUser) {
    return this.kyc.businessEligibility(user.id);
  }

  // ── Admin (FR-901): business AML re-screen + retained history ──────────────────────
  @Post('admin/aml-screen')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Standalone AML screen of a business entity' })
  @UseGuards(PrivyAuthGuard, AdminGuard)
  adminScreenAml(@Body() dto: AmlScreenDto) {
    const { userId, ...params } = dto;
    return this.kyc.screenBusinessAml(userId, params);
  }

  @Get('admin/aml/:userId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Business AML screening history (NFR-19 retained)' })
  @UseGuards(PrivyAuthGuard, AdminGuard)
  adminListScreenings(@Param('userId') userId: string) {
    return this.kyc.listBusinessScreenings(userId);
  }
}
