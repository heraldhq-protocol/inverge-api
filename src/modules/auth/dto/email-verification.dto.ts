import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class RequestEmailCodeDto {
  @ApiProperty({ description: 'Address to verify. Normalised server-side.' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  email!: string;
}

export class VerifyEmailCodeDto {
  @ApiProperty({ description: 'The address the code was sent to.' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ description: 'Six-digit numeric code.' })
  @Transform(trimString)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be six digits' })
  code!: string;
}
