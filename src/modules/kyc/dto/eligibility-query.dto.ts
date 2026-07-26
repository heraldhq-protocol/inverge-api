import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { KYC_PURPOSES, KycPurpose } from '../../../ports/kyc/kyc-provider.port';

export class EligibilityQueryDto {
  @ApiPropertyOptional({ enum: KYC_PURPOSES, default: 'IDEA_VALIDATION' })
  @IsOptional()
  @IsIn(KYC_PURPOSES as unknown as string[])
  purpose?: KycPurpose;
}
