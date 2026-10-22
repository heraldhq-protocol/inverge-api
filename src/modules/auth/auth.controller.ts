import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateCreatorProfileDto } from './dto/update-creator-profile.dto';
import {
  MeResponseDto,
  SessionResponseDto,
  UsernameAvailabilityDto,
} from './dto/auth-response.dto';
import { AccountCapabilitiesDto } from './dto/capabilities-response.dto';
import { PrivyAuthGuard } from './guards/privy-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('session')
  @ApiOperation({ summary: 'Exchange a provider access token for an Inverge session' })
  @ApiOkResponse({ type: SessionResponseDto })
  session(@Body() dto: CreateSessionDto) {
    return this.auth.authenticate(dto.accessToken, dto.walletAddress);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOkResponse({ type: MeResponseDto })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.id);
  }

  @Get('capabilities')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({
    summary: 'What the signed-in account may do, for UI gating',
    description:
      'Presentation only. Every route re-checks ownership, role and eligibility on the server.',
  })
  @ApiOkResponse({ type: AccountCapabilitiesDto })
  capabilities(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.capabilities(user.id);
  }

  @Get('check-username')
  @ApiOperation({ summary: 'Check if a username handle is available' })
  @ApiOkResponse({ type: UsernameAvailabilityDto })
  checkUsername(@Query('username') username: string) {
    return this.auth.checkUsernameAvailability(username);
  }

  @Patch('me/profile')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({ summary: 'Update creator display profile' })
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateCreatorProfileDto,
  ) {
    return this.auth.updateProfile(user.id, dto);
  }

  @Get('creators/:idOrUsername')
  @ApiOperation({ summary: 'Get public creator profile and their projects/backed ideas' })
  getPublicProfile(@Param('idOrUsername') idOrUsername: string) {
    return this.auth.getPublicProfile(idOrUsername);
  }
}
