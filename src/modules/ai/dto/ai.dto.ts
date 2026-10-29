import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  IDEA_ASSISTANT_ACTIONS,
  IDEA_ASSISTANT_FIELDS,
  type IdeaAssistantAction,
  type IdeaAssistantField,
} from '../ai.constants';

export class IdeaAssistantDto {
  @ApiProperty({ enum: IDEA_ASSISTANT_ACTIONS })
  @IsIn(IDEA_ASSISTANT_ACTIONS)
  action!: IdeaAssistantAction;

  @ApiProperty({
    enum: IDEA_ASSISTANT_FIELDS,
    description: 'The draft field the proposal is for',
  })
  @IsIn(IDEA_ASSISTANT_FIELDS)
  target!: IdeaAssistantField;

  @ApiProperty({ description: 'Current text of the target field' })
  @IsString()
  @Length(1, 4_000)
  text!: string;

  @ApiPropertyOptional({
    type: Object,
    additionalProperties: { type: 'string' },
    description:
      'Other draft fields for coherence. Unknown keys and non-strings are ignored server-side.',
  })
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;

  @ApiProperty({
    description: 'Revision of the text the client sent, echoed back for staleness checks',
  })
  @IsString()
  @MaxLength(80)
  baseRevision!: string;

  @ApiProperty({ description: 'Client-generated idempotency/telemetry id' })
  @IsUUID()
  clientRequestId!: string;
}

export class IdeaAssistantMetaDto {
  @ApiProperty() model!: string;
  @ApiProperty() promptVersion!: string;
  @ApiProperty() inputTokens!: number;
  @ApiProperty() outputTokens!: number;
  @ApiProperty() latencyMs!: number;
}

export class IdeaAssistantResultDto {
  @ApiProperty() suggestionId!: string;
  @ApiProperty({ enum: IDEA_ASSISTANT_ACTIONS }) action!: string;
  @ApiProperty({ enum: IDEA_ASSISTANT_FIELDS }) target!: string;
  @ApiProperty() baseRevision!: string;
  @ApiProperty({ nullable: true }) proposal!: string | null;
  @ApiProperty({ type: [String] }) notes!: string[];
  @ApiProperty({ type: [String] }) assumptions!: string[];
  @ApiProperty({ type: IdeaAssistantMetaDto }) meta!: IdeaAssistantMetaDto;
}

export class AiAccessDto {
  @ApiProperty() feature!: string;
  @ApiProperty() configured!: boolean;
  @ApiProperty() premium!: boolean;
  @ApiProperty({ enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'NOT_REQUIRED'] })
  requestStatus!: string;
  @ApiProperty() canRequest!: boolean;
  @ApiProperty({ nullable: true }) source!: string | null;
  @ApiProperty({ nullable: true }) expiresAt!: string | null;
  @ApiProperty() requestsToday!: number;
  @ApiProperty() tokensToday!: number;
  @ApiProperty() requestsPerDay!: number;
  @ApiProperty() tokensPerDay!: number;
}

export class DecideAiAccessDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsIn(['APPROVED', 'REJECTED'])
  status!: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({ description: 'ISO instant; omit for no expiry' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

export class ListAiAccessQueryDto {
  @ApiPropertyOptional({ enum: ['PENDING', 'APPROVED', 'REJECTED'] })
  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED'])
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
