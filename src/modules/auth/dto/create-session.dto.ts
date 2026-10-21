import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateSessionDto {
  @ApiProperty({
    description:
      'Identity token from the auth/wallet provider (Web3Auth id_token). In stub mode use "stub:<did>[:<email>]".',
  })
  @IsString()
  @IsNotEmpty()
  accessToken!: string;

  @ApiPropertyOptional({
    description:
      'Solana address to link. Verified against the signed identity token; it is never trusted as given. Omit to sign in without linking a wallet.',
  })
  @IsOptional()
  @IsString()
  walletAddress?: string;
}
