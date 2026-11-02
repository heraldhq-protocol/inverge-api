import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import {
  CreateAccountRequestDto,
  UpdateFeedSettingsDto,
  UpdateNotificationSettingsDto,
} from './dto/settings.dto';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@ApiBearerAuth()
@UseGuards(PrivyAuthGuard)
@Controller('me/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Account settings aggregate',
    description:
      'Profile, email state, feed scope, notification preferences, verification summary, wallet link and recent support requests. Private provider references are never included.',
  })
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.get(user.id);
  }

  @Put('feed')
  @ApiOperation({
    summary: 'Update discovery-feed topics, region and promoted placement',
  })
  updateFeed(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateFeedSettingsDto,
  ) {
    return this.settings.updateFeed(user.id, dto);
  }

  @Put('notifications')
  @ApiOperation({ summary: 'Update email notification delivery preferences' })
  updateNotifications(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateNotificationSettingsDto,
  ) {
    return this.settings.updateNotifications(user.id, dto);
  }

  @Post('requests')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Request a data export or account deletion review',
    description:
      'Creates an auditable support request. Deletion is reviewed before any data is removed because of retention and campaign obligations.',
  })
  createRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAccountRequestDto,
  ) {
    return this.settings.createRequest(user.id, dto);
  }
}
