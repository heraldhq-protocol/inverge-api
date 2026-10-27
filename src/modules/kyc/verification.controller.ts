import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type {
  RiskOutcome,
  VerificationStatus,
} from '../../generated/prisma/client';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { ComplianceReviewerGuard } from '../auth/guards/compliance-reviewer.guard';
import { PrivyAuthGuard } from '../auth/guards/privy-auth.guard';
import {
  AccountTypeDto,
  AdminCaseQueryDto,
  ContributionAuthorizationDto,
  ResolveRiskDto,
  VerificationBusinessDto,
  VerificationSessionDto,
} from './dto/verification.dto';
import { EligibilityQueryDto } from './dto/eligibility-query.dto';
import { VerificationService } from './verification.service';

const CASE_STATUSES: VerificationStatus[] = [
  'NOT_STARTED',
  'SESSION_CREATED',
  'AWAITING_USER',
  'SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'DECLINED',
  'ACTION_REQUIRED',
  'EXPIRED',
  'CANCELLED',
  'ERROR',
];

const RISK_OUTCOMES: RiskOutcome[] = ['NOT_ASSESSED', 'CLEAR', 'REVIEW', 'FLAGGED'];

function parseList<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  field: string,
): T[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (values.length === 0) return undefined;
  const invalid = values.filter(
    (value) => !(allowed as readonly string[]).includes(value),
  );
  if (invalid.length > 0) {
    throw new BadRequestException(`Unknown ${field}: ${invalid.join(', ')}`);
  }
  return values as T[];
}

// Creator-facing verification surface. Every eligibility answer here is derived from
// persisted provider state; the web app never talks to Didit and never decides for itself.
@ApiTags('verification')
@Controller('verification')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get('state')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({ summary: 'Normalised verification state and outstanding requirements' })
  state(@CurrentUser() user: AuthenticatedUser) {
    return this.verification.state(user.id);
  }

  @Get('eligibility')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  eligibility(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: EligibilityQueryDto,
  ) {
    return this.verification.eligibility(user.id, query.purpose ?? 'IDEA_VALIDATION');
  }

  @Post('session')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({ summary: 'Start or restart a hosted verification session' })
  session(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerificationSessionDto,
  ) {
    return this.verification.startSession(user.id, {
      purpose: dto.purpose,
      subject: dto.subject,
    });
  }

  @Post('business/session')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({ summary: 'Register the business and start KYB' })
  businessSession(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerificationBusinessDto,
  ) {
    return this.verification.startBusinessSession(user.id, dto);
  }

  @Get('business')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  businessStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.verification.businessStatus(user.id);
  }

  @Post('account-type')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({ summary: 'Choose individual or business account shape' })
  accountType(@CurrentUser() user: AuthenticatedUser, @Body() dto: AccountTypeDto) {
    return this.verification.setAccountType(user.id, dto.accountType);
  }

  @Post('contributions/authorize')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard)
  @ApiOperation({
    summary: 'Authorise a contribution against the FR-104 cumulative threshold',
  })
  authorizeContribution(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ContributionAuthorizationDto,
  ) {
    return this.verification.authorizeContribution(
      user.id,
      dto.campaignId,
      dto.amountUsd,
    );
  }

  // Provider callback. Public. The adapter verifies the signature against the raw body;
  // the service re-fetches the authoritative decision. Never a browser redirect.
  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});
    return this.verification.handleWebhook(raw, headers);
  }

  // ── Admin / compliance review ──────────────────────────────────────────────────

  @Get('admin/cases')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard, ComplianceReviewerGuard)
  @ApiOperation({ summary: 'Paginated verification cases for review' })
  adminCases(@Query() query: AdminCaseQueryDto) {
    return this.verification.adminListCases({
      cursor: query.cursor,
      limit: query.limit,
      requiresReview: query.requiresReview,
      risks: parseList(query.risk, RISK_OUTCOMES, 'risk'),
      statuses: parseList(query.status, CASE_STATUSES, 'status'),
      type: query.type,
    });
  }

  @Get('admin/queues')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard, ComplianceReviewerGuard)
  @ApiOperation({ summary: 'Review queues, provider errors and reconciliation status' })
  adminQueues() {
    return this.verification.adminQueues();
  }

  @Get('admin/cases/:id')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard, ComplianceReviewerGuard)
  @ApiOperation({ summary: 'Case detail and append-only event history' })
  adminCase(@Param('id') id: string) {
    return this.verification.adminCaseDetail(id);
  }

  @Post('admin/cases/:id/resolve')
  @ApiBearerAuth()
  @UseGuards(PrivyAuthGuard, ComplianceReviewerGuard)
  @ApiOperation({ summary: 'Record a reasoned review of an AML/sanctions outcome' })
  adminResolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ResolveRiskDto,
  ) {
    return this.verification.adminResolveRisk(user.id, id, dto);
  }
}
