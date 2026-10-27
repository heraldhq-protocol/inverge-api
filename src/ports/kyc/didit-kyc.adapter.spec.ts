import { createHmac } from 'crypto';
import { DiditKycAdapter, extractAml, extractFeatures } from './didit-kyc.adapter';
import {
  canonicalJson,
  verifyDiditSignature,
} from '../../modules/kyc/didit-webhook-verifier';

const cfg = (over: Record<string, any> = {}) =>
  ({
    get: (k: string) =>
      ({
        DIDIT_BASE_URL: 'https://verification.didit.me/v3',
        DIDIT_API_KEY: 'test-key',
        DIDIT_KYC_WORKFLOW_ID: 'wf-kyc',
        DIDIT_KYC_AML_WORKFLOW_ID: 'wf-aml',
        DIDIT_KYB_WORKFLOW_ID: 'wf-kyb',
        DIDIT_WEBHOOK_SECRET: 'shhh',
        DIDIT_CALLBACK_URL: 'https://app/cb',
        ...over,
      })[k],
  }) as any;

function mockFetch(resp: unknown, ok = true, status = 200) {
  const fn = jest.fn().mockResolvedValue({
    headers: { get: () => null },
    ok,
    status,
    text: async () => JSON.stringify(resp),
  });
  (global as any).fetch = fn;
  return fn;
}

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

describe('extractFeatures', () => {
  it('maps decision arrays and feature objects to stable codes', () => {
    expect(
      extractFeatures({
        aml_screenings: [{}],
        features: [{ feature: 'OCR' }, 'NFC'],
        id_verifications: [{}],
        key_people_checks: [{}],
      }),
    ).toEqual(['AML', 'ID_VERIFICATION', 'KYB_KEY_PEOPLE', 'NFC', 'OCR']);
  });
});

describe('DiditKycAdapter.startVerification', () => {
  it('uses the AML workflow for funds purposes and passes vendor_data', async () => {
    const fetchMock = mockFetch({ session_id: 'sess1', url: 'https://verify/sess1' });
    const a = new DiditKycAdapter(cfg());
    const res = await a.startVerification({
      vendorData: 'user-1',
      purpose: 'CAMPAIGN_CREATOR',
    });
    expect(res).toMatchObject({ providerRef: 'sess1', verificationUrl: 'https://verify/sess1' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.workflow_id).toBe('wf-aml');
    expect(body.vendor_data).toBe('user-1');
  });

  it('uses the identity-only workflow for idea validation', async () => {
    const fetchMock = mockFetch({ session_id: 's', url: 'u' });
    await new DiditKycAdapter(cfg()).startVerification({
      vendorData: 'u2',
      purpose: 'IDEA_VALIDATION',
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.workflow_id).toBe('wf-kyc');
  });

  it('uses the KYB workflow and expected_details for business verification', async () => {
    const fetchMock = mockFetch({ session_id: 's', url: 'u' });
    await new DiditKycAdapter(cfg()).startVerification({
      business: { legalName: 'Acme Ltd', country: 'ng' },
      purpose: 'BUSINESS_VERIFICATION',
      vendorData: 'biz-1',
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.workflow_id).toBe('wf-kyb');
    expect(body.expected_details).toEqual({
      company_name: 'Acme Ltd',
      registry_country: 'NG',
    });
  });

  it('throws a clear error when the needed workflow id is missing', async () => {
    mockFetch({});
    const a = new DiditKycAdapter(cfg({ DIDIT_KYC_AML_WORKFLOW_ID: undefined }));
    await expect(
      a.startVerification({ vendorData: 'u', purpose: 'CAMPAIGN_CREATOR' }),
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
    expect(d.providerStatus).toBe('Approved');
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

  it('throws with status on a non-2xx response', async () => {
    mockFetch({ detail: 'bad key' }, false, 401);
    await expect(new DiditKycAdapter(cfg()).getDecision('x')).rejects.toThrow(/401/);
  });
});

describe('verifyDiditSignature', () => {
  const body = '{"session_id":"s1","status":"Approved","webhook_type":"status.updated"}';
  const secret = 'shhh';
  const now = () => Math.floor(Date.now() / 1000);

  it('accepts a correct raw-body HMAC (x-signature)', () => {
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(
      verifyDiditSignature({
        headers: { 'x-signature': sig, 'x-timestamp': String(now()) },
        rawBody: body,
        secret,
      }).ok,
    ).toBe(true);
  });

  it('rejects a wrong signature', () => {
    const verdict = verifyDiditSignature({
      headers: { 'x-signature': 'deadbeef', 'x-timestamp': String(now()) },
      rawBody: body,
      secret,
    });
    expect(verdict).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects when no signature header is present', () => {
    const verdict = verifyDiditSignature({
      headers: { 'x-timestamp': String(now()) },
      rawBody: body,
      secret,
    });
    expect(verdict).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a stale timestamp', () => {
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    const verdict = verifyDiditSignature({
      headers: { 'x-signature': sig, 'x-timestamp': String(now() - 10_000) },
      rawBody: body,
      secret,
    });
    expect(verdict).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('rejects when no secret is configured', () => {
    const verdict = verifyDiditSignature({
      headers: { 'x-timestamp': String(now()) },
      rawBody: body,
      secret: undefined,
    });
    expect(verdict).toEqual({ ok: false, reason: 'secret_missing' });
  });

  it('accepts the canonical V2 signature', () => {
    const ts = now();
    const canonical = canonicalJson(JSON.parse(body));
    const v2 = createHmac('sha256', secret).update(canonical).digest('hex');
    expect(
      verifyDiditSignature({
        headers: { 'x-signature-v2': v2, 'x-timestamp': String(ts) },
        nowSeconds: ts,
        rawBody: body,
        secret,
      }),
    ).toMatchObject({ authenticatesPayload: true, ok: true, scheme: 'v2' });
  });

  it('flags the deprecated Simple signature as not payload-authenticating', () => {
    const ts = now();
    const parsed = JSON.parse(body);
    const message = [parsed.timestamp ?? '', parsed.session_id, parsed.status, parsed.webhook_type].join(':');
    const simple = createHmac('sha256', secret).update(message).digest('hex');
    expect(
      verifyDiditSignature({
        headers: { 'x-signature-simple': simple, 'x-timestamp': String(ts) },
        nowSeconds: ts,
        rawBody: body,
        secret,
      }),
    ).toMatchObject({ authenticatesPayload: false, ok: true, scheme: 'simple' });
  });
});
