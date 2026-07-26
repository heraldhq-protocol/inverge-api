import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

// FR-901: grant/revoke admin. Kept as a string literal set (not the Prisma enum object)
// so validation has no runtime dependency on the generated client's enum shape.
export class UpdateUserRoleDto {
  @ApiProperty({ enum: ['USER', 'ADMIN'] })
  @IsIn(['USER', 'ADMIN'])
  role!: 'USER' | 'ADMIN';
}
