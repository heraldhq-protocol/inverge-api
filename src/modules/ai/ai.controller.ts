import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { AdminGuard } from '../auth/guards/admin.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import { AiEntitlementService } from './ai-entitlement.service';
import { AiService } from './ai.service';
import {
  AiAccessDto,
  DecideAiAccessDto,
  IdeaAssistantDto,
  IdeaAssistantResultDto,
  ListAiAccessQueryDto,
} from './dto/ai.dto';

@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
@UseGuards(PrivyAuthGuard)
export class AiController {
  constructor(private readonly entitlement: AiEntitlementService) {}

  @Get('access')
  @RateLimit('ai_assistant')
  @ApiOperation({ summary: 'AI assistant entitlement and today\'s usage' })
  @ApiOkResponse({ type: AiAccessDto })
  access(@CurrentUser() user: AuthenticatedUser): Promise<AiAccessDto> {
    return this.entitlement.getAccess(user);
  }

  @Post('access-requests')
  @RateLimit('ai_assistant')
  @ApiOperation({ summary: 'Request AI assistant access' })
  @ApiOkResponse({ type: AiAccessDto })
  requestAccess(@CurrentUser() user: AuthenticatedUser): Promise<AiAccessDto> {
    return this.entitlement.requestAccess(user);
  }
}

@ApiTags('ai')
@ApiBearerAuth()
@Controller('ideas')
@UseGuards(PrivyAuthGuard)
export class IdeaAssistantController {
  constructor(private readonly ai: AiService) {}

  @Post(':ideaId/assistant')
  @RateLimit('ai_assistant')
  @ApiOperation({ summary: 'Suggest a revision for one idea draft field' })
  @ApiOkResponse({ type: IdeaAssistantResultDto })
  suggest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ideaId') ideaId: string,
    @Body() dto: IdeaAssistantDto,
  ): Promise<IdeaAssistantResultDto> {
    return this.ai.suggestForIdea(user, ideaId, dto);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/ai')
@UseGuards(PrivyAuthGuard, AdminGuard)
export class AdminAiController {
  constructor(private readonly entitlement: AiEntitlementService) {}

  @Get('access-requests')
  @RateLimit('admin')
  @ApiOperation({ summary: 'List AI assistant access requests' })
  list(@Query() query: ListAiAccessQueryDto) {
    return this.entitlement.listRequests(query);
  }

  @Patch('access-requests/:id')
  @RateLimit('admin')
  @ApiOperation({ summary: 'Approve or reject an AI assistant request' })
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecideAiAccessDto,
  ) {
    return this.entitlement.decide(user.id, id, dto);
  }
}
