import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { RateLimit } from '../../../common/rate-limit/rate-limit.decorator';
import { PrivyAuthGuard } from '../guards/privy-auth.guard';
import {
  RequestEmailCodeDto,
  VerifyEmailCodeDto,
} from '../dto/email-verification.dto';
import { EmailVerificationService } from './email-verification.service';

@ApiTags('auth')
@ApiBearerAuth()
@UseGuards(PrivyAuthGuard)
@Controller('auth/email')
export class EmailVerificationController {
  constructor(private readonly email: EmailVerificationService) {}

  @Get()
  @ApiOperation({ summary: 'Current email address and verification state' })
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.email.status(user.id);
  }

  @Post('request')
  @HttpCode(200)
  @RateLimit('email_request')
  @ApiOperation({ summary: 'Request a six-digit code for an address' })
  async request(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestEmailCodeDto,
  ) {
    const result = await this.email.request(user.id, dto.email);
    if (result.status === 'cooldown' || result.status === 'rate_limited') {
      throw new HttpException(
        {
          code:
            result.status === 'cooldown'
              ? 'EMAIL_RESEND_COOLDOWN'
              : 'EMAIL_RATE_LIMITED',
          message:
            result.status === 'cooldown'
              ? 'Wait before requesting another code.'
              : 'Too many verification emails requested. Try again later.',
          retryAfterSeconds: result.retryAfterSeconds,
        },
        429,
      );
    }
    if (result.status === 'delivery_failed') {
      throw new HttpException(
        {
          code: 'EMAIL_DELIVERY_FAILED',
          message:
            'The verification email could not be sent. Try again shortly.',
        },
        502,
      );
    }
    return result;
  }

  @Post('verify')
  @HttpCode(200)
  @RateLimit('email_verify')
  @ApiOperation({ summary: 'Verify a six-digit email code' })
  async verify(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyEmailCodeDto,
  ) {
    const result = await this.email.verify(user.id, dto.email, dto.code);
    if (result.status === 'invalid') {
      throw new HttpException(
        {
          code: 'EMAIL_CODE_INVALID',
          message: 'That code is not valid. Check it and try again.',
        },
        400,
      );
    }
    if (result.status === 'expired') {
      throw new HttpException(
        {
          code: 'EMAIL_CODE_EXPIRED',
          message: 'That code has expired. Request a new one.',
        },
        400,
      );
    }
    if (result.status === 'too_many_attempts') {
      throw new HttpException(
        {
          code: 'EMAIL_TOO_MANY_ATTEMPTS',
          message: 'Too many incorrect attempts. Request a new code.',
        },
        429,
      );
    }
    if (result.status === 'unavailable') {
      throw new HttpException(
        {
          code: 'EMAIL_UNAVAILABLE',
          message:
            'That address cannot be used for this account. Try another address or sign in with the method you originally used.',
        },
        409,
      );
    }
    return result;
  }

  @Post('resend')
  @HttpCode(200)
  @RateLimit('email_resend')
  @ApiOperation({ summary: 'Resend the active verification code' })
  async resend(@CurrentUser() user: AuthenticatedUser) {
    const result = await this.email.resend(user.id);
    if (result.status === 'cooldown' || result.status === 'rate_limited') {
      throw new HttpException(
        {
          code:
            result.status === 'cooldown'
              ? 'EMAIL_RESEND_COOLDOWN'
              : 'EMAIL_RATE_LIMITED',
          message:
            result.status === 'cooldown'
              ? 'Wait before requesting another code.'
              : 'Too many verification emails requested. Try again later.',
          retryAfterSeconds: result.retryAfterSeconds,
        },
        429,
      );
    }
    if (result.status === 'delivery_failed') {
      throw new HttpException(
        {
          code: 'EMAIL_DELIVERY_FAILED',
          message:
            'The verification email could not be sent. Try again shortly.',
        },
        502,
      );
    }
    return result;
  }

  @Delete('pending')
  @ApiOperation({ summary: 'Cancel a pending email change' })
  cancelPending(@CurrentUser() user: AuthenticatedUser) {
    return this.email.cancelPending(user.id);
  }
}
