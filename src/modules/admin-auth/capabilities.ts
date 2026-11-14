import type { AdminRole } from '../../generated/prisma/enums';

/**
 * What a dedicated admin session may do (docs/admin/admin-auth.md 5.3).
 *
 * These are capability strings, not route names. The web may hide controls it
 * cannot use, but every admin route must still re-check the capability on the
 * server; the list is a projection of the role, never an authority of its own.
 */
export const ADMIN_CAPABILITIES = [
  'admins.manage',
  'campaigns.read',
  'campaigns.review',
  'verification.review',
  'programmes.read',
  'programmes.manage',
  'advertising.manage',
  'payments.read',
  'audit.read',
  'settings.manage',
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

const READ_ONLY: readonly AdminCapability[] = [
  'campaigns.read',
  'programmes.read',
  'payments.read',
  'audit.read',
];

const CAPABILITIES_BY_ROLE: Record<AdminRole, readonly AdminCapability[]> = {
  SUPER_ADMIN: ADMIN_CAPABILITIES,
  OPERATOR: [
    'campaigns.read',
    'campaigns.review',
    'programmes.read',
    'programmes.manage',
    'advertising.manage',
    'payments.read',
    'audit.read',
  ],
  REVIEWER: ['campaigns.read', 'verification.review', 'audit.read'],
  READ_ONLY,
};

export function adminCapabilitiesForRole(
  role: AdminRole,
): readonly AdminCapability[] {
  return CAPABILITIES_BY_ROLE[role];
}
