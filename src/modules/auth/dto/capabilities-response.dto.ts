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

export class AnalyticsCapabilitiesDto {
  @ApiProperty({
    description:
      'False when the operator has disabled analytics reads; entitlement may still be recorded.',
  })
  available!: boolean;

  @ApiProperty({ enum: ['basic', 'premium', 'admin'] })
  tier!: 'basic' | 'premium' | 'admin';

  @ApiProperty({
    enum: ['STARTER', 'TRUSTED', 'ESTABLISHED'],
    nullable: true,
  })
  creatorTier!: 'STARTER' | 'TRUSTED' | 'ESTABLISHED' | null;

  @ApiProperty()
  premium!: boolean;

  @ApiProperty({
    enum: [
      'NONE',
      'PENDING',
      'APPROVED',
      'REJECTED',
      'EXPIRED',
      'NOT_REQUIRED',
    ],
  })
  requestStatus!:
    | 'NONE'
    | 'PENDING'
    | 'APPROVED'
    | 'REJECTED'
    | 'EXPIRED'
    | 'NOT_REQUIRED';

  @ApiProperty({
    description:
      'True when the account may request premium access; false while pending or approved.',
  })
  canRequest!: boolean;

  @ApiProperty({ type: [String] })
  features!: string[];
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

  @ApiProperty({ type: AnalyticsCapabilitiesDto })
  analytics!: AnalyticsCapabilitiesDto;

  @ApiProperty({ description: 'ISO 8601 timestamp' })
  asOf!: string;
}
