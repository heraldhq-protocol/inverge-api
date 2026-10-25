import { ApiProperty } from '@nestjs/swagger';

export class CapabilityVerificationDto {
  @ApiProperty()
  identityVerified!: boolean;

  @ApiProperty()
  fundsEligible!: boolean;

  @ApiProperty({
    type: [String],
    description: 'Human-readable reasons funds-eligibility is not met; empty when eligible.',
  })
  blockers!: string[];
}

export class CapabilityFlagsDto {
  @ApiProperty()
  createIdeas!: boolean;

  @ApiProperty()
  supportIdeas!: boolean;

  @ApiProperty()
  prePledge!: boolean;

  @ApiProperty()
  purchaseBoosts!: boolean;

  @ApiProperty()
  submitCampaigns!: boolean;

  @ApiProperty()
  reviewCampaigns!: boolean;

  @ApiProperty()
  moderateContent!: boolean;

  @ApiProperty()
  managePlatform!: boolean;
}

export class AccountCapabilitiesDto {
  @ApiProperty({ enum: ['USER', 'ADMIN'] })
  role!: 'USER' | 'ADMIN';

  @ApiProperty()
  accountActive!: boolean;

  @ApiProperty()
  requiresOnboarding!: boolean;

  @ApiProperty({ type: CapabilityVerificationDto })
  verification!: CapabilityVerificationDto;

  @ApiProperty({ type: CapabilityFlagsDto })
  capabilities!: CapabilityFlagsDto;

  @ApiProperty({ description: 'ISO 8601 timestamp' })
  asOf!: string;
}
