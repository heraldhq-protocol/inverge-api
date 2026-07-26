import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AmlOutcome,
  AmlScreeningParams,
  AmlScreeningResult,
  KycDecision,
  KycOutcome,
  KycProviderPort,
  KycWebhookEvent,
  StartVerificationParams,
  StartVerificationResult,
} from './kyc-provider.port';

// Offline dev/test adapter. No network, fully deterministic.
//   - startVerification returns a dev URL whose ref encodes the purpose, so the round trip
//     knows whether AML was part of the flow.
//   - getDecision resolves that ref to a happy-path decision (VERIFIED; AML CLEAR for funds
//     purposes, null for identity-only).
//   - parseWebhook accepts a plain JSON body (dev POST) — no signature required offline.
//   - screenAml applies simple keyword rules so the FLAGGED / IN_REVIEW branches are testable
//     without a provider (mirrors the deterministic moderation stub).
@Injectable()
export class StubKycAdapter implements KycProviderPort {
  async startVerification(
    params: StartVerificationParams,
  ): Promise<StartVerificationResult> {
    const providerRef = `stubkyc_${params.purpose}_${randomUUID()}`;
    const url = new URL('http://localhost:3000/kyc/dev-complete');
    url.searchParams.set('ref', providerRef);
    url.searchParams.set('user', params.userId);
    return { providerRef, verificationUrl: url.toString() };
  }

  async getDecision(providerRef: string): Promise<KycDecision> {
    const runsAml = refRequiresAml(providerRef);
    return {
      providerRef,
      status: 'VERIFIED',
      aml: runsAml ? 'CLEAR' : null,
      amlSummary: runsAml ? { totalHits: 0, topRiskScore: 0, datasets: [] } : null,
      raw: { stub: true, providerRef },
    };
  }

  parseWebhook(rawBody: string): KycWebhookEvent | null {
    let evt: any;
    try {
      evt = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const providerRef = evt?.providerRef ?? evt?.session_id;
    if (!providerRef) return null;
    return {
      providerRef,
      vendorData: evt?.vendor_data ?? evt?.vendorData ?? null,
      status: normalizeStubStatus(evt?.status),
      aml: normalizeStubAml(evt?.aml),
    };
  }

  async screenAml(params: AmlScreeningParams): Promise<AmlScreeningResult> {
    const status = keywordAml(params.fullName);
    const hit = status !== 'CLEAR';
    return {
      status,
      totalHits: hit ? 1 : 0,
      topRiskScore: status === 'FLAGGED' ? 100 : status === 'IN_REVIEW' ? 85 : 0,
      datasets: status === 'FLAGGED' ? ['Sanctions'] : status === 'IN_REVIEW' ? ['PEP'] : [],
      raw: { stub: true, screened: params.fullName },
    };
  }
}

function refRequiresAml(providerRef: string): boolean {
  // ref is `stubkyc_<PURPOSE>_<uuid>`; PURPOSE itself contains an underscore, so match by
  // substring rather than positional split.
  return (
    providerRef.includes('CAMPAIGN_CREATOR') ||
    providerRef.includes('BACKER_THRESHOLD')
  );
}

function normalizeStubStatus(s: unknown): KycOutcome {
  switch (s) {
    case 'REJECTED':
    case 'Declined':
      return 'REJECTED';
    case 'IN_REVIEW':
    case 'In Review':
      return 'IN_REVIEW';
    case 'PENDING':
      return 'PENDING';
    default:
      return 'VERIFIED';
  }
}

function normalizeStubAml(a: unknown): AmlOutcome | null {
  if (a === 'FLAGGED' || a === 'Declined') return 'FLAGGED';
  if (a === 'IN_REVIEW' || a === 'In Review') return 'IN_REVIEW';
  if (a === 'CLEAR' || a === 'Approved') return 'CLEAR';
  return null;
}

// Deterministic offline AML rule so the non-CLEAR paths can be exercised in tests.
function keywordAml(name: string): AmlOutcome {
  const n = (name ?? '').toLowerCase();
  if (/(sanction|ofac|blocked|terror)/.test(n)) return 'FLAGGED';
  if (/(\bpep\b|politically|review)/.test(n)) return 'IN_REVIEW';
  return 'CLEAR';
}
