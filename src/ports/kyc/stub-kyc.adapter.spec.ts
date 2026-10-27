import { StubKycAdapter } from './stub-kyc.adapter';

describe('StubKycAdapter', () => {
  const a = new StubKycAdapter();

  it('encodes the purpose in the ref and returns a dev URL', async () => {
    const r = await a.startVerification({ vendorData: 'u1', purpose: 'CAMPAIGN_CREATOR' });
    expect(r.providerRef).toContain('CAMPAIGN_CREATOR');
    expect(r.verificationUrl).toContain('ref=');
    expect(r.verificationUrl).toContain('user=u1');
  });

  it('getDecision runs AML for funds purposes, skips it for idea validation', async () => {
    const funds = await a.startVerification({ vendorData: 'u', purpose: 'BACKER_THRESHOLD' });
    expect((await a.getDecision(funds.providerRef)).aml).toBe('CLEAR');

    const idea = await a.startVerification({ vendorData: 'u', purpose: 'IDEA_VALIDATION' });
    expect((await a.getDecision(idea.providerRef)).aml).toBeNull();
  });

  it('parseWebhook reads providerRef + vendor_data + status', () => {
    const evt = a.parseWebhook(
      JSON.stringify({ providerRef: 'r1', vendor_data: 'u9', status: 'REJECTED' }),
    );
    expect(evt).toMatchObject({ providerRef: 'r1', vendorData: 'u9', status: 'REJECTED' });
  });

  it('parseWebhook returns null on garbage / missing ref', () => {
    expect(a.parseWebhook('not json')).toBeNull();
    expect(a.parseWebhook(JSON.stringify({ status: 'VERIFIED' }))).toBeNull();
  });

  it('screenAml applies deterministic keyword rules', async () => {
    expect((await a.screenAml({ fullName: 'Jane Doe' })).status).toBe('CLEAR');
    expect((await a.screenAml({ fullName: 'OFAC Sanction Test' })).status).toBe('FLAGGED');
    expect((await a.screenAml({ fullName: 'A Politically Exposed Person' })).status).toBe('IN_REVIEW');
  });
});
