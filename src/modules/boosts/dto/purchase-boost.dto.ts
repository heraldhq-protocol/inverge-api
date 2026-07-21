import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const BOOST_TIERS = ['BASIC', 'FEATURED'] as const;
export type BoostTierValue = (typeof BOOST_TIERS)[number];

export class PurchaseBoostDto {
  @ApiProperty({ enum: BOOST_TIERS })
  @IsIn(BOOST_TIERS)
  tier!: BoostTierValue;
}
