import type { AdminRole } from '../../generated/prisma/enums';
import type { AdminCapability } from './capabilities';

export interface AdminIdentity {
  id: string;
  email: string;
  displayName: string;
  role: AdminRole;
  capabilities: readonly AdminCapability[];
}

export interface AdminSessionContext {
  sessionId: string;
  expiresAt: Date;
  admin: AdminIdentity;
}
