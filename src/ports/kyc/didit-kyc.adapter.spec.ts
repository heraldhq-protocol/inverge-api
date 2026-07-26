import { createHmac } from 'crypto';
import {
  DiditKycAdapter,
  extractAml,
  mapAmlStatus,
  mapKycStatus,
} from './didit-kyc.adapter';

const cfg = (over: Record<string, any> = {}) =>
  ({
    get: (k: string) =>
      ({
        DIDIT_BASE_URL: 'https://verification.didit.me/v3',
        DIDIT_API_KEY: 'test-key',
        DIDIT_KYC_WORKFLOW_ID: 'wf-kyc',
        DIDIT_KYC_AML_WORKFLOW_ID: 'wf-aml',
        DIDIT_WEBHOOK_SECRET: 'shhh',
        DIDIT_CALLBACK_URL: 'https://app/cb',
        ...over,
      })[k],
  }) as any;

function mockFetch(resp: unknown, ok = true, status = 200) {
  const fn = jest.fn().mockResolvedValue({
    ok,
    status,
    text: async () => JSON.stringify(resp),
  });
  (global as any).fetch = fn;
  return fn;
}

describe('mapKycStatus', () => {
  it('maps provider statuses onto our vocabulary', () => {
    expect(mapKycStatus('Approved')).toBe('VERIFIED');
    expect(mapKycStatus('Declined')).toBe('REJECTED');
    expect(mapKycStatus('In Review')).toBe('IN_REVIEW');
    expect(mapKycStatus('In Progress')).toBe('PENDING');
    expect(mapKycStatus('Expired')).toBe('PENDING');
    expect(mapKycStatus(undefined)).toBe('PENDING');
  });
});

describe('mapAmlStatus', () => {
  it('maps AML statuses', () => {
    expect(mapAmlStatus('Approved')).toBe('CLEAR');
    expect(mapAmlStatus('In Review')).toBe('IN_REVIEW');
    expect(mapAmlStatus('Rejected')).toBe('FLAGGED');
    expect(mapAmlStatus('Declined')).toBe('FLAGGED');
  });
});

describe('extractAml', () => {
  it('reads the standalone {aml:{...}} shape and filters false positives', () => {
    const out = extractAml({
      aml: {
        status: 'In Review',
        total_hits: 2,
        score: 40,
        hits: [
          { review_status: 'False Positive', risk_score: 10, datasets: ['PEP'] },
          { review_status: 'Unreviewed', risk_score: 85, datasets: ['Sanctions'] },
        ],
      },
    });
    expect(out).toEqual({
      outcome: 'IN_REVIEW',
      summary: { totalHits: 2, topRiskScore: 85, datasets: ['Sanctions'] },
    });
  });

  it('reads the session decision {aml_screenings:[...]} shape', () => {
    const out = extractAml({
      status: 'Approved',
      aml_screenings: [{ status: 'Approved', total_hits: 0, score: 0, hits: [] }],
    });
    expect(out?.outcome).toBe('CLEAR');
    expect(out?.summary.totalHits).toBe(0);
  });

  it('treats an empty aml_screenings array as no AML data', () => {
    expect(extractAml({ status: 'Approved', aml_screenings: [] })).toBeNull();
  });

  it('returns null when there is no AML block at all', () => {
    expect(extractAml({ status: 'Approved' })).toBeNull();
    expect(extractAml(null)).toBeNull();
  });

  it('falls back to block.score when no non-FP hits carry a risk score', () => {
    const out = extractAml({
      aml: { status: 'Approved', total_hits: 1, score: 12, hits: [{ review_status: 'False Positive', risk_score: 5 }] },
    });
    expect(out?.summary.topRiskScore).toBe(12);
  });
});

describe('DiditKycAdapter.startVerification', () => {
  it('uses the AML workflow for funds purposes and passes vendor_data', async () => {
    const fetchMock = mockFetch({ session_id: 'sess1', url: 'https://verify/sess1' });
    const a = new DiditKycAdapter(cfg());
    const res = await a.startVerification({
      userId: 'user-1',
      purpose: 'CAMPAIGN_CREATOR',
    });
    expect(res).toEqual({ providerRef: 'sess1', verificationUrl: 'https://verify/sess1' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.workflow_id).toBe('wf-aml');
    expect(body.vendor_data).toBe('user-1');
  });

  it('uses the identity-only workflow for idea validation', async () => {
    const fetchMock = mockFetch({ session_id: 's', url: 'u' });
    await new DiditKycAdapter(cfg()).startVerification({
      userId: 'u2',
      purpose: 'IDEA_VALIDATION',
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.workflow_id).toBe('wf-kyc');
  });

  it('throws a clear error when the needed workflow id is missing', async () => {
    mockFetch({});
    const a = new DiditKycAdapter(cfg({ DIDIT_KYC_AML_WORKFLOW_ID: undefined }));
    await expect(
      a.startVerification({ userId: 'u', purpose: 'CAMPAIGN_CREATOR' }),
    ).rejects.toThrow(/DIDIT_KYC_AML_WORKFLOW_ID/);
  });
});

describe('DiditKycAdapter.getDecision / screenAml', () => {
  it('normalizes a decision with AML', async () => {
    mockFetch({
      status: 'Approved',
      aml: { status: 'Approved', total_hits: 0, score: 0, hits: [] },
    });
    const d = await new DiditKycAdapter(cfg()).getDecision('sess1');
    expect(d.status).toBe('VERIFIED');
    expect(d.aml).toBe('CLEAR');
  });

  it('posts the AML screen to /aml/ with full_name', async () => {
    const fetchMock = mockFetch({
      aml: { status: 'Rejected', total_hits: 1, score: 100, hits: [{ review_status: 'Confirmed Match', risk_score: 100, datasets: ['Sanctions'] }] },
    });
    const r = await new DiditKycAdapter(cfg()).screenAml({ fullName: 'John Smith' });
    expect(fetchMock.mock.calls[0][0]).toContain('/aml/');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.full_name).toBe('John Smith');
    expect(r.status).toBe('FLAGGED');
    expect(r.datasets).toEqual(['Sanctions']);
  });

  it('throws with status + body on a non-2xx response', async () => {
    mockFetch({ detail: 'bad key' }, false, 401);
    await expect(new DiditKycAdapter(cfg()).getDecision('x')).rejects.toThrow(/401/);
  });
});

describe('DiditKycAdapter.verifySignature', () => {
  const body = JSON.stringify({ session_id: 's1', status: 'Approved', webhook_type: 'status.updated' });
  const secret = 'shhh';
  const rawSig = createHmac('sha256', secret).update(body).digest('hex');
  const now = () => String(Math.floor(Date.now() / 1000));

  it('accepts a correct raw-body HMAC (x-signature)', () => {
    const a = new DiditKycAdapter(cfg());
    expect(a.verifySignature(body, { 'x-signature': rawSig, 'x-timestamp': now() })).toBe(true);
  });

  it('rejects a wrong signature when a secret is set', () => {
    const a = new DiditKycAdapter(cfg());
    expect(a.verifySignature(body, { 'x-signature': 'deadbeef', 'x-timestamp': now() })).toBe(false);
  });

  it('rejects when no signature header is present', () => {
    const a = new DiditKycAdapter(cfg());
    expect(a.verifySignature(body, { 'x-timestamp': now() })).toBe(false);
  });

  it('rejects a stale timestamp', () => {
    const a = new DiditKycAdapter(cfg());
    const stale = String(Math.floor(Date.now() / 1000) - 10_000);
    expect(a.verifySignature(body, { 'x-signature': rawSig, 'x-timestamp': stale })).toBe(false);
  });

  it('skips verification (accepts) when no secret is configured', () => {
    const a = new DiditKycAdapter(cfg({ DIDIT_WEBHOOK_SECRET: undefined }));
    expect(a.verifySignature(body, {})).toBe(true);
  });

  it('accepts the canonical V2 signature', () => {
    const ts = now();
    const canonical = JSON.stringify({ session_id: 's1', status: 'Approved', webhook_type: 'status.updated' });
    // canonicalize sorts keys — recompute to match the adapter's canonical form.
    const sorted = '{"session_id":"s1","status":"Approved","webhook_type":"status.updated"}';
    const v2 = createHmac('sha256', secret).update(`${ts}:${sorted}`).digest('hex');
    const a = new DiditKycAdapter(cfg());
    expect(a.verifySignature(canonical, { 'x-signature-v2': v2, 'x-timestamp': ts })).toBe(true);
  });
});
