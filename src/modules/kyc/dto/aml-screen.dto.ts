import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

// Admin standalone AML screen (ongoing monitoring / re-screen). full_name is the only field
// the provider requires; the rest sharpen matching and cut false positives.
export class AmlScreenDto {
  @ApiProperty({ description: 'Inverge user id to attach the screening record to' })
  @IsString()
  @MinLength(1)
  userId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  fullName!: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsISO8601()
  dateOfBirth?: string;

  @ApiPropertyOptional({ description: 'ISO country code (alpha-2 / alpha-3)' })
  @IsOptional()
  @IsString()
  nationality?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  documentNumber?: string;

  @ApiPropertyOptional({ enum: ['person', 'company'], default: 'person' })
  @IsOptional()
  @IsIn(['person', 'company'])
  entityType?: 'person' | 'company';
}
