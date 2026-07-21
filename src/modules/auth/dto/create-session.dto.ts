import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateSessionDto {
  @ApiProperty({
    description:
      'Access token from the auth/wallet provider (Privy). In stub mode use "stub:<did>[:<email>]".',
  })
  @IsString()
  @IsNotEmpty()
  accessToken!: string;
}
