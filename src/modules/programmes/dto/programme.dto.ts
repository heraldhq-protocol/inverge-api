import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { parseBooleanQuery } from '../../../common/http/boolean-query';
import {
  DISCOVERY_MAX_PAGE_SIZE,
  DISCOVERY_PAGE_SIZE,
} from '../../../common/http/pagination';

export const PROGRAMME_TYPE_VALUES = [
  'MONTHLY_IDEATHON',
  'SPONSORED_CHALLENGE',
  'SHOWCASE',
  'WORKSHOP',
  'EXPERT_SESSION',
  'OTHER',
] as const;

export const PROGRAMME_STATUS_VALUES = [
  'DRAFT',
  'SCHEDULED',
  'REGISTRATION_OPEN',
  'SUBMISSION_OPEN',
  'JUDGING',
  'RESULTS_REVIEW',
  'COMPLETED',
  'ARCHIVED',
] as const;

export const PROGRAMME_ENTRY_MODE_VALUES = [
  'NEW_IDEAS_ONLY',
  'EXISTING_IDEAS_ONLY',
  'NEW_OR_EXISTING',
] as const;

export const PROGRAMME_ENTRY_SOURCE_VALUES = ['NEW_IDEA', 'EXISTING_IDEA'] as const;

export const PROGRAMME_JUDGING_METHOD_VALUES = [
  'COMMUNITY',
  'JUDGES',
  'HYBRID',
  'CURATED',
] as const;

export const PROGRAMME_REVIEW_STATUS_VALUES = [
  'UNDER_REVIEW',
  'CHANGES_REQUESTED',
  'SHORTLISTED',
  'ACCEPTED',
  'REJECTED',
  'DISQUALIFIED',
] as const;

export const PROGRAMME_PRIZE_KIND_VALUES = ['CASH', 'NON_CASH', 'MIXED'] as const;
export const PROGRAMME_PRIZE_FULFILMENT_VALUES = [
  'UNCONFIRMED',
  'COMMITTED',
  'FUNDED',
  'PROCESSING',
  'DELIVERED',
  'FAILED',
] as const;
export const PROGRAMME_SPONSOR_INVOICE_VALUES = [
  'DRAFT',
  'ISSUED',
  'PENDING',
  'PAID',
  'OVERDUE',
  'CANCELLED',
] as const;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ProgrammeFaqDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  question!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  answer!: string;
}

export class ProgrammeAssetDto {
  @ApiProperty({ enum: ['banner', 'thumbnail', 'partner_logo'] })
  @IsIn(['banner', 'thumbnail', 'partner_logo'])
  kind!: 'banner' | 'thumbnail' | 'partner_logo';

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  alt!: string;
}

export class ProgrammeModuleDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  key!: string;

  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({
    enum: ['available', 'preview', 'coming_soon', 'plan'],
  })
  @IsOptional()
  @IsIn(['available', 'preview', 'coming_soon', 'plan'])
  availability?: 'available' | 'preview' | 'coming_soon' | 'plan';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}

export class ProgrammeCustomQuestionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  id!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(280)
  label!: string;

  @ApiPropertyOptional({ enum: ['text', 'long_text', 'url', 'select', 'boolean'] })
  @IsOptional()
  @IsIn(['text', 'long_text', 'url', 'select', 'boolean'])
  kind?: 'text' | 'long_text' | 'url' | 'select' | 'boolean';

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  options?: string[];
}

export class RubricCriterionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  id!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ description: 'Whole percentage. All criteria must total 100.' })
  @IsInt()
  @Min(0)
  @Max(100)
  weight!: number;

  @ApiProperty({ default: 0 })
  @IsNumber()
  @Min(0)
  @Max(100)
  minScore!: number;

  @ApiProperty({ default: 10 })
  @IsNumber()
  @Min(1)
  @Max(100)
  maxScore!: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  required?: boolean;
}

export class TieBreakRuleDto {
  @ApiProperty({ enum: ['CRITERION', 'CRITERIA_AVERAGE', 'SUBMITTED_AT', 'JUDGE_DECISION'] })
  @IsIn(['CRITERION', 'CRITERIA_AVERAGE', 'SUBMITTED_AT', 'JUDGE_DECISION'])
  type!: 'CRITERION' | 'CRITERIA_AVERAGE' | 'SUBMITTED_AT' | 'JUDGE_DECISION';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  criteria?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(280)
  label?: string;
}

export class ProgrammeTimelineDto {
  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  registrationOpensAt!: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  registrationClosesAt!: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  submissionOpensAt!: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  submissionClosesAt!: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  judgingStartsAt!: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  judgingEndsAt!: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  resultsAt!: string;
}

export class CreateProgrammeDto extends ProgrammeTimelineDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lower-case letters, numbers and single hyphens',
  })
  slug!: string;

  @ApiProperty({ enum: PROGRAMME_TYPE_VALUES })
  @IsIn(PROGRAMME_TYPE_VALUES)
  type!: (typeof PROGRAMME_TYPE_VALUES)[number];

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  tagline!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  description!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  category!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  organiser!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  heroCopy?: string;

  @ApiPropertyOptional({ default: 'UTC' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  rules?: string[];

  @ApiPropertyOptional({ type: [ProgrammeFaqDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => ProgrammeFaqDto)
  faqs?: ProgrammeFaqDto[];

  @ApiPropertyOptional({ type: [ProgrammeAssetDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ProgrammeAssetDto)
  assets?: ProgrammeAssetDto[];

  @ApiPropertyOptional({ type: [ProgrammeModuleDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ProgrammeModuleDto)
  modules?: ProgrammeModuleDto[];

  @ApiPropertyOptional({ enum: PROGRAMME_ENTRY_MODE_VALUES, default: 'NEW_OR_EXISTING' })
  @IsOptional()
  @IsIn(PROGRAMME_ENTRY_MODE_VALUES)
  entryMode?: (typeof PROGRAMME_ENTRY_MODE_VALUES)[number];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  registrationRequired?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  requireEmailVerified?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  allowedCategories?: string[];

  @ApiPropertyOptional({ description: '0..1 quality threshold, or null for none' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minQualityScore?: number | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  allowMultipleEntries?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxEntriesPerParticipant?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  allowTeams?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  teamMinSize?: number;

  @ApiPropertyOptional({ default: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  teamMaxSize?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  requiredFields?: string[];

  @ApiPropertyOptional({ type: [ProgrammeCustomQuestionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => ProgrammeCustomQuestionDto)
  customQuestions?: ProgrammeCustomQuestionDto[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  acceptedLinkHosts?: string[];

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  maxAttachments?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  allowDraftEditing?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  allowWithdrawal?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  lateEntriesAllowed?: boolean;

  @ApiPropertyOptional({ enum: PROGRAMME_JUDGING_METHOD_VALUES, default: 'JUDGES' })
  @IsOptional()
  @IsIn(PROGRAMME_JUDGING_METHOD_VALUES)
  judgingMethod?: (typeof PROGRAMME_JUDGING_METHOD_VALUES)[number];

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  communityWeight?: number;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  judgeWeight?: number;

  @ApiPropertyOptional({ type: [RubricCriterionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => RubricCriterionDto)
  rubric?: RubricCriterionDto[];

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  minimumEvaluations?: number;

  @ApiPropertyOptional({ enum: ['EXCLUDE', 'ZERO'], default: 'EXCLUDE' })
  @IsOptional()
  @IsIn(['EXCLUDE', 'ZERO'])
  missingEvaluationPolicy?: 'EXCLUDE' | 'ZERO';

  @ApiPropertyOptional({ type: [TieBreakRuleDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TieBreakRuleDto)
  tieBreak?: TieBreakRuleDto[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  requireConflictDeclaration?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Allow a judge to revise an already-submitted evaluation. Every revision is retained.',
  })
  @IsOptional()
  @IsBoolean()
  allowEvaluationRevision?: boolean;
}

export class UpdateProgrammeDto extends PartialType(CreateProgrammeDto) {
  @ApiProperty({ description: 'Current version for optimistic concurrency (FR-1201)' })
  @IsInt()
  @Min(1)
  version!: number;
}

export class ListProgrammesQueryDto {
  @ApiPropertyOptional({ default: DISCOVERY_PAGE_SIZE, maximum: DISCOVERY_MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DISCOVERY_MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque nextCursor from the previous page.' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ enum: PROGRAMME_TYPE_VALUES })
  @IsOptional()
  @IsIn(PROGRAMME_TYPE_VALUES)
  type?: (typeof PROGRAMME_TYPE_VALUES)[number];

  @ApiPropertyOptional({ enum: PROGRAMME_STATUS_VALUES })
  @IsOptional()
  @IsIn(PROGRAMME_STATUS_VALUES)
  status?: (typeof PROGRAMME_STATUS_VALUES)[number];

  @ApiPropertyOptional({ description: 'Filter by programme category' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;
}

export class ListAdminProgrammesQueryDto extends ListProgrammesQueryDto {
  @ApiPropertyOptional({ description: 'Include drafts and archived programmes' })
  @IsOptional()
  @Transform(parseBooleanQuery)
  @IsBoolean()
  includeUnpublished?: boolean;
}

export class RegisterForProgrammeDto {
  @ApiPropertyOptional({ description: 'Optional note for the organiser' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class EntryTeamMemberDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  role?: string;
}

export class CreateProgrammeEntryDto {
  @ApiProperty({ description: 'Idea id owned by the caller' })
  @IsString()
  @IsNotEmpty()
  ideaId!: string;

  @ApiProperty({ enum: PROGRAMME_ENTRY_SOURCE_VALUES })
  @IsIn(PROGRAMME_ENTRY_SOURCE_VALUES)
  source!: (typeof PROGRAMME_ENTRY_SOURCE_VALUES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @ApiPropertyOptional({ description: 'Draft answers keyed by field id' })
  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [EntryTeamMemberDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => EntryTeamMemberDto)
  teamMembers?: EntryTeamMemberDto[];
}

export class UpdateProgrammeEntryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [EntryTeamMemberDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => EntryTeamMemberDto)
  teamMembers?: EntryTeamMemberDto[];
}

export class SubmitProgrammeEntryDto {
  @ApiPropertyOptional({
    description:
      'The participant confirms the work is theirs and the snapshot is final for this submission.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  confirmOriginalWork?: boolean;
}

export class WithdrawProgrammeEntryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class DeclareJudgeConflictDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class SaveEvaluationDto {
  @ApiProperty({ description: 'Raw score per rubric criterion id' })
  @IsObject()
  scores!: Record<string, number>;

  @ApiPropertyOptional({ description: 'Private to the judging panel; never public' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  privateComment?: string;

  @ApiPropertyOptional({ description: 'Published to the participant if results allow' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  participantFeedback?: string;
}

export class SubmitEvaluationDto extends SaveEvaluationDto {
  @ApiPropertyOptional({
    description: 'Judge declares no undisclosed conflict with this entry',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  declareNoConflict?: boolean;
}

export class AssignJudgeDto {
  @ApiPropertyOptional({ description: 'Existing user id' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  judgeId?: string;

  @ApiPropertyOptional({ description: 'Email of an existing verified account' })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  conflictDeclaration?: string;
}

export class AdminEntryDecisionDto {
  @ApiProperty({ enum: PROGRAMME_REVIEW_STATUS_VALUES })
  @IsIn(PROGRAMME_REVIEW_STATUS_VALUES)
  status!: (typeof PROGRAMME_REVIEW_STATUS_VALUES)[number];

  @ApiPropertyOptional({ description: 'Moderator note; never shown publicly' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class CuratedRankDto {
  @ApiProperty({ description: '1-based rank, or null to clear' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  curatedRank?: number | null;
}

export class ProgrammePrizeDto {
  @ApiProperty({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  placement?: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  description!: string;

  @ApiProperty({ enum: PROGRAMME_PRIZE_KIND_VALUES })
  @IsIn(PROGRAMME_PRIZE_KIND_VALUES)
  kind!: (typeof PROGRAMME_PRIZE_KIND_VALUES)[number];

  @ApiPropertyOptional({ description: 'Integer atomic amount string' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,30}$/)
  amountAtomic?: string;

  @ApiPropertyOptional({ default: 'USD' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @ApiPropertyOptional({ default: 2 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(18)
  decimals?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  awardCriteria?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  eligibility?: string;

  @ApiPropertyOptional({ enum: PROGRAMME_PRIZE_FULFILMENT_VALUES })
  @IsOptional()
  @IsIn(PROGRAMME_PRIZE_FULFILMENT_VALUES)
  fundingStatus?: (typeof PROGRAMME_PRIZE_FULFILMENT_VALUES)[number];

  @ApiPropertyOptional({ enum: PROGRAMME_PRIZE_FULFILMENT_VALUES })
  @IsOptional()
  @IsIn(PROGRAMME_PRIZE_FULFILMENT_VALUES)
  fulfilmentStatus?: (typeof PROGRAMME_PRIZE_FULFILMENT_VALUES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  fulfilmentOwner?: string;
}

export class UpdateProgrammePrizeDto extends PartialType(ProgrammePrizeDto) {
  @ApiPropertyOptional({ enum: PROGRAMME_PRIZE_FULFILMENT_VALUES })
  @IsOptional()
  @IsIn(PROGRAMME_PRIZE_FULFILMENT_VALUES)
  fundingStatus?: (typeof PROGRAMME_PRIZE_FULFILMENT_VALUES)[number];
}

export class ProgrammeSponsorDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ default: 'partner' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  tier?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  website?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  logoUrl?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  deliverables?: string[];

  @ApiPropertyOptional({ description: 'Integer atomic cash commitment' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,30}$/)
  commitmentAtomic?: string;

  @ApiPropertyOptional({ default: 'USD' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @ApiPropertyOptional({ enum: PROGRAMME_SPONSOR_INVOICE_VALUES })
  @IsOptional()
  @IsIn(PROGRAMME_SPONSOR_INVOICE_VALUES)
  invoiceStatus?: (typeof PROGRAMME_SPONSOR_INVOICE_VALUES)[number];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  confirmedByProvider?: boolean;
}

export class UpdateProgrammeSponsorDto extends PartialType(ProgrammeSponsorDto) {}

export class ProgrammeAnnouncementDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  body!: string;

  @ApiPropertyOptional({ description: 'Omit to keep the announcement as a draft' })
  @IsOptional()
  @IsDateString()
  publishedAt?: string;
}

export class PublishResultsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    enum: ['PROVISIONAL', 'PUBLIC'],
    default: 'PUBLIC',
    description:
      'PROVISIONAL is visible to participants only; PUBLIC activates the public leaderboard.',
  })
  @IsOptional()
  @IsIn(['PROVISIONAL', 'PUBLIC'])
  visibility?: 'PROVISIONAL' | 'PUBLIC';
}

export class UpdateProgrammeStatusDto {
  @ApiProperty({ enum: PROGRAMME_STATUS_VALUES })
  @IsIn(PROGRAMME_STATUS_VALUES)
  status!: (typeof PROGRAMME_STATUS_VALUES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ProgrammeEntryListQueryDto {
  @ApiPropertyOptional({ default: DISCOVERY_PAGE_SIZE, maximum: DISCOVERY_MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DISCOVERY_MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn([
    'DRAFT',
    'SUBMITTED',
    'UNDER_REVIEW',
    'CHANGES_REQUESTED',
    'SHORTLISTED',
    'ACCEPTED',
    'REJECTED',
    'DISQUALIFIED',
    'WITHDRAWN',
  ])
  status?: string;
}

export class ProgrammeSlugParamDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  slug!: string;
}
