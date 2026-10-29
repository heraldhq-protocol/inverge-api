import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response contracts for the routes the web client consumes first.
 *
 * These describe the fields a client may rely on. `GET /auth/me` currently returns
 * a superset of the underlying user row; that projection is narrowed in the next
 * stage, and the DTO is the contract rather than a mirror of storage.
 */

export class SessionUserDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty()
  emailVerified!: boolean;

  @ApiProperty({ type: String, nullable: true })
  emailVerifiedAt!: string | null;

  @ApiProperty({ enum: ['USER', 'ADMIN'] })
  role!: 'USER' | 'ADMIN';
}

export class PublicCreatorLinkDto {
  @ApiProperty()
  label!: string;

  @ApiProperty()
  url!: string;
}

export class PublicCreatorDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  avatarUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  bio!: string | null;

  @ApiProperty({ type: [PublicCreatorLinkDto] })
  links!: PublicCreatorLinkDto[];

  @ApiProperty({ enum: ['STARTER', 'TRUSTED', 'ESTABLISHED'] })
  tier!: 'STARTER' | 'TRUSTED' | 'ESTABLISHED';

  @ApiProperty()
  completedCampaigns!: number;

  @ApiProperty()
  ideasPublished!: number;

  @ApiProperty()
  identityVerified!: boolean;

  @ApiProperty({ description: 'ISO 8601 timestamp' })
  memberSince!: string;
}

export class SessionResponseDto {
  @ApiProperty({
    description:
      'One-hour HS256 session token. The web BFF stores it in an HttpOnly cookie and never returns it to the browser.',
  })
  sessionToken!: string;

  @ApiProperty({ type: SessionUserDto })
  user!: SessionUserDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Provider-supplied address that is not proven. Prefill only; never stored.',
  })
  suggestedEmail!: string | null;

  @ApiProperty({ type: PublicCreatorDto, nullable: true })
  creator!: PublicCreatorDto | null;

  @ApiProperty()
  requiresOnboarding!: boolean;

  @ApiProperty()
  requiresEmailVerification!: boolean;
}

export class MeResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty()
  emailVerified!: boolean;

  @ApiProperty({ type: String, nullable: true })
  emailVerifiedAt!: string | null;

  @ApiProperty({ enum: ['USER', 'ADMIN'] })
  role!: 'USER' | 'ADMIN';

  @ApiProperty({ type: PublicCreatorDto, nullable: true })
  creator!: PublicCreatorDto | null;

  @ApiProperty()
  requiresOnboarding!: boolean;

  @ApiProperty()
  requiresEmailVerification!: boolean;
}

export class UsernameAvailabilityDto {
  @ApiProperty()
  available!: boolean;

  @ApiPropertyOptional()
  reason?: string;
}
