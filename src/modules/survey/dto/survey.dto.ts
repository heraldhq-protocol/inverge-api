import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const SURVEY_QUESTION_TYPES = ['RATING', 'TEXT', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'BOOLEAN'] as const;

export class SurveyQuestionDto {
  @ApiProperty({ description: 'Display order (0-based)' }) @IsInt() @Min(0) @Max(100) index!: number;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(280) prompt!: string;
  @ApiProperty({ enum: SURVEY_QUESTION_TYPES }) @IsIn(SURVEY_QUESTION_TYPES) type!: (typeof SURVEY_QUESTION_TYPES)[number];

  @ApiPropertyOptional({ type: [String], description: 'Options for SINGLE_CHOICE / MULTI_CHOICE' })
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20) @MaxLength(120, { each: true })
  options?: string[];

  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() required?: boolean;
}

// FR-202/203: the creator sets the whole question set (replace-all).
export class SetSurveyDto {
  @ApiProperty({ type: [SurveyQuestionDto], description: '1–20 questions; at least one RATING' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => SurveyQuestionDto)
  questions!: SurveyQuestionDto[];
}

export class AnswerDto {
  @ApiProperty() @IsString() @IsNotEmpty() questionId!: string;
  // Polymorphic by question type (number | string | boolean | string[]); validated server-side.
  @ApiProperty({ description: 'number | string | boolean | string[] depending on the question type' })
  @IsDefined()
  value!: number | string | boolean | string[];
}

export class SubmitResponseDto {
  @ApiProperty({ type: [AnswerDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => AnswerDto)
  answers!: AnswerDto[];
}
