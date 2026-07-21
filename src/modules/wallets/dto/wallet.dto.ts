import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsNotEmpty } from 'class-validator';

export const WALLET_ROLES = ['FUNDING', 'PAYOUT'] as const;
export type WalletRoleValue = (typeof WALLET_ROLES)[number];

export class LinkWalletDto {
  @ApiProperty({ description: 'External Solana wallet address' })
  @IsString()
  @IsNotEmpty()
  address!: string;

  @ApiProperty({ description: 'Signature proving ownership of the address' })
  @IsString()
  @IsNotEmpty()
  ownershipSignature!: string;

  @ApiPropertyOptional({ enum: WALLET_ROLES, default: 'PAYOUT' })
  @IsOptional()
  @IsIn(WALLET_ROLES)
  role?: WalletRoleValue;
}

export class SetWalletRoleDto {
  @ApiProperty({ enum: WALLET_ROLES })
  @IsIn(WALLET_ROLES)
  role!: WalletRoleValue;
}
