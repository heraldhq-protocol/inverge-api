import { ADMIN_CAPABILITIES, adminCapabilitiesForRole } from './capabilities';

describe('adminCapabilitiesForRole', () => {
  it('grants every capability to a super admin', () => {
    expect(adminCapabilitiesForRole('SUPER_ADMIN')).toEqual(
      ADMIN_CAPABILITIES,
    );
  });

  it('keeps a reviewer out of money and programme management', () => {
    const capabilities = adminCapabilitiesForRole('REVIEWER');

    expect(capabilities).toContain('verification.review');
    expect(capabilities).toContain('campaigns.read');
    expect(capabilities).not.toContain('campaigns.review');
    expect(capabilities).not.toContain('payments.read');
    expect(capabilities).not.toContain('programmes.manage');
  });

  it('lets an operator review campaigns but not manage admins', () => {
    const capabilities = adminCapabilitiesForRole('OPERATOR');

    expect(capabilities).toContain('campaigns.review');
    expect(capabilities).toContain('programmes.manage');
    expect(capabilities).not.toContain('admins.manage');
    expect(capabilities).not.toContain('settings.manage');
  });

  it('gives read-only admins only read capabilities', () => {
    expect(adminCapabilitiesForRole('READ_ONLY')).toEqual([
      'campaigns.read',
      'programmes.read',
      'payments.read',
      'audit.read',
    ]);
  });
});
