import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import {
  AdminAuthService,
  type AdminMeResult,
  type LoginResult,
  type MfaResult,
} from './admin-auth.service';
import {
  AdminSessionGuard,
  requireAdminSession,
  type AdminAuthenticatedRequest,
} from './admin-session.guard';
import { AdminLoginDto } from './dto/login.dto';
import { AdminMfaDto } from './dto/mfa.dto';

@ApiTags('admin-auth')
@Controller('admin-auth')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RateLimit('auth')
  @ApiOperation({
    summary: 'Verify an admin password and issue a single-use MFA challenge',
  })
  login(
    @Body() dto: AdminLoginDto,
    @Req() request: Request,
  ): Promise<LoginResult> {
    return this.adminAuth.login(dto.email, dto.password, {
      ip: request.ip,
      userAgent: request.get('user-agent') ?? null,
    });
  }

  @Post('mfa')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RateLimit('auth')
  @ApiOperation({
    summary: 'Exchange an MFA challenge and TOTP code for a session',
  })
  mfa(@Body() dto: AdminMfaDto, @Req() request: Request): Promise<MfaResult> {
    return this.adminAuth.verifyMfa(dto.challengeToken, dto.code, {
      ip: request.ip,
      userAgent: request.get('user-agent') ?? null,
    });
  }

  @Get('me')
  @UseGuards(AdminSessionGuard)
  @RateLimit('admin')
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the current admin and session expiry' })
  @ApiOkResponse()
  me(@Req() request: AdminAuthenticatedRequest): AdminMeResult {
    const session = requireAdminSession(request);
    return { admin: session.admin, expiresAt: session.expiresAt };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AdminSessionGuard)
  @RateLimit('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the current admin session' })
  @ApiNoContentResponse()
  async logout(@Req() request: AdminAuthenticatedRequest): Promise<void> {
    await this.adminAuth.logout(requireAdminSession(request));
  }
}
