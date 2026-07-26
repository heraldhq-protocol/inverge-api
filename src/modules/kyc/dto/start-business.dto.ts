import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// Registers the caller's business and starts KYB. Didit's registry/document/UBO checks fill
// in the rest — we only need enough to identify the company.
export class StartBusinessDto {
  @ApiProperty({ description: 'Registered legal name of the business' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  legalName!: string;

  @ApiPropertyOptional({ description: 'Company / registration number' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  registrationNumber?: string;

  @ApiPropertyOptional({ description: 'ISO country of registration' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  country?: string;
}
