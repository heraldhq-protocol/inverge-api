import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { KYC_PURPOSES, KycPurpose } from '../../../ports/kyc/kyc-provider.port';

export class StartSessionDto {
  // What the verification is for. Defaults to idea-validation identity (no AML). Funds
  // purposes run the AML workflow. See FR-103 / FR-104.
  @ApiPropertyOptional({ enum: KYC_PURPOSES, default: 'IDEA_VALIDATION' })
  @IsOptional()
  @IsIn(KYC_PURPOSES as unknown as string[])
  purpose?: KycPurpose;
}
