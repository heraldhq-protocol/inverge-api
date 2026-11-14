import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class AdminMfaDto {
  @ApiProperty({ description: 'The challenge token returned by the password step.' })
  @IsString()
  @Matches(/^inv_chl_[A-Za-z0-9_-]{43}$/)
  challengeToken!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
