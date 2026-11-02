import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type { Env } from '../../config/env.validation';
import { assertStubProviderAllowed } from '../stub-guard';
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
import type { DiditStatus } from '../../modules/kyc/verification-status';

// Offline dev/test adapter. No network, fully deterministic.
//   - startVerification returns a dev URL whose ref encodes the purpose, so the round trip
//     knows whether AML was part of the flow.
//   - getDecision resolves that ref to a happy-path decision (VERIFIED; AML CLEAR for funds
//     purposes, null for identity-only).
//   - parseWebhook accepts a plain JSON body (dev POST) - no signature required offline.
//   - screenAml applies simple keyword rules so the FLAGGED / IN_REVIEW branches are testable
//     without a provider (mirrors the deterministic moderation stub).
@Injectable()
export class StubKycAdapter implements KycProviderPort {
  // Remembers the outcome a session was "completed" with (via dev-complete -> parseWebhook) so
  // getDecision can echo it authoritatively - the stub is a faithful in-process simulator.
  private readonly completed = new Map<
    string,
    { status: KycOutcome; aml: AmlOutcome | null }
  >();

  constructor(
    @Optional() private readonly config?: ConfigService<Env, true>,
  ) {}

  async startVerification(
    params: StartVerificationParams,
  ): Promise<StartVerificationResult> {
    assertStubProviderAllowed('KYC', this.config);
    const providerRef = `stubkyc_${params.purpose}_${randomUUID()}`;
    const url = new URL('http://localhost:3000/kyc/dev-complete');
    url.searchParams.set('ref', providerRef);
    url.searchParams.set('user', params.vendorData);
    return {
      providerRef,
      sessionKind:
        params.purpose === 'BUSINESS_VERIFICATION' ? 'business' : 'user',
      verificationUrl: url.toString(),
      workflowId: null,
    };
  }

  async getDecision(providerRef: string): Promise<KycDecision> {
    assertStubProviderAllowed('KYC', this.config);
    const runsAml = refRequiresAml(providerRef);
    const isBusiness = providerRef.includes('BUSINESS_VERIFICATION');
    const done = this.completed.get(providerRef);
    const status: KycOutcome = done?.status ?? 'VERIFIED';
    // AML only applies to a passing identity result on an AML workflow.
    const aml: AmlOutcome | null =
      status === 'VERIFIED' && runsAml ? (done?.aml ?? 'CLEAR') : null;
    const features = [
      ...(isBusiness
        ? ['KYB_REGISTRY', 'KYB_DOCUMENTS', 'KYB_KEY_PEOPLE']
        : ['ID_VERIFICATION', 'LIVENESS', 'FACE_MATCH']),
      ...(runsAml ? ['AML'] : []),
    ];
    return {
      aml,
      amlSummary: aml
        ? {
            datasets: aml === 'CLEAR' ? [] : ['Sanctions'],
            topRiskScore: aml === 'CLEAR' ? 0 : 100,
            totalHits: aml === 'CLEAR' ? 0 : 1,
          }
        : null,
      createdAt: new Date().toISOString(),
      decisionId: providerRef,
      features,
      providerRef,
      providerStatus: diditLabelFor(status),
      status,
      warningCodes:
        status === 'VERIFIED'
          ? []
          : status === 'REJECTED'
            ? ['STUB_DECLINED']
            : ['STUB_REVIEW'],
    };
  }

  parseWebhook(rawBody: string): KycWebhookEvent | null {
    assertStubProviderAllowed('KYC', this.config);
    let evt: any;
    try {
      evt = JSON.parse(rawBody);
    } catch {
      return null;
    }

    const webhookType =
      typeof evt?.webhook_type === 'string' ? evt.webhook_type : 'status.updated';
    const providerRef = evt?.providerRef ?? evt?.session_id ?? null;
    const transactionId = evt?.transaction_id ?? null;
    const vendorUserId = evt?.vendor_user_id ?? null;
    const vendorBusinessId = evt?.vendor_business_id ?? null;

    const resourceType =
      webhookType === 'status.updated' || webhookType === 'data.updated'
        ? 'SESSION'
        : webhookType.startsWith('user.')
          ? 'USER'
          : webhookType.startsWith('business.')
            ? 'BUSINESS'
            : webhookType.startsWith('transaction.')
              ? 'TRANSACTION'
              : 'ACTIVITY';
    const resourceId =
      resourceType === 'SESSION'
        ? providerRef
        : resourceType === 'TRANSACTION'
          ? transactionId
          : resourceType === 'USER'
            ? vendorUserId
            : resourceType === 'BUSINESS'
              ? vendorBusinessId
              : (evt?.activity_id ?? evt?.event_id ?? null);
    if (!resourceId) return null;

    const isSession = resourceType === 'SESSION';
    const status = isSession ? normalizeStubStatus(evt?.status) : null;
    const aml = normalizeStubAml(evt?.aml);
    if (isSession && providerRef) this.completed.set(providerRef, { status: status!, aml });

    const timestamp = Number.isFinite(Number(evt?.timestamp))
      ? Number(evt.timestamp)
      : Math.floor(Date.now() / 1000);
    const createdAt = Number.isFinite(Number(evt?.created_at))
      ? Number(evt.created_at)
      : timestamp;

    return {
      aml,
      businessEntityRef: vendorBusinessId,
      businessSessionId: evt?.business_session_id ?? null,
      changedFields: Array.isArray(evt?.changed_fields)
        ? evt.changed_fields.filter((entry: unknown): entry is string => typeof entry === 'string')
        : [],
      eventId:
        typeof evt?.event_id === 'string'
          ? evt.event_id
          : `stub:${resourceType}:${resourceId}:${status ?? evt?.status ?? 'NONE'}:${timestamp}`,
      occurredAt: new Date(createdAt * 1000),
      payloadAuthenticated: true,
      previousStatus:
        typeof evt?.previous_status === 'string' ? evt.previous_status : null,
      providerRef: isSession ? providerRef : null,
      providerStatus: isSession ? diditLabelFor(status!) : null,
      rawStatus: typeof evt?.status === 'string' ? evt.status : null,
      resourceId,
      resourceType,
      sessionKind: evt?.session_kind === 'business' ? 'business' : null,
      status,
      transaction:
        resourceType === 'TRANSACTION'
          ? {
              actionRequired:
                evt?.action_required && typeof evt.action_required === 'object'
                  ? evt.action_required
                  : null,
              amount: typeof evt?.amount === 'string' ? evt.amount : null,
              currency: typeof evt?.currency === 'string' ? evt.currency : null,
              direction: typeof evt?.direction === 'string' ? evt.direction : null,
              id: transactionId,
              score: typeof evt?.score === 'number' ? evt.score : null,
              severity: typeof evt?.severity === 'string' ? evt.severity : null,
              status: typeof evt?.status === 'string' ? evt.status : null,
              txnId: typeof evt?.txn_id === 'string' ? evt.txn_id : null,
            }
          : null,
      trigger: typeof evt?.trigger === 'string' ? evt.trigger : null,
      vendorData: evt?.vendor_data ?? evt?.vendorData ?? null,
      webhookType: webhookType as KycWebhookEvent['webhookType'],
    };
  }

  async screenAml(params: AmlScreeningParams): Promise<AmlScreeningResult> {
    assertStubProviderAllowed('KYC', this.config);
    const status = keywordAml(params.fullName);
    const hit = status !== 'CLEAR';
    return {
      datasets:
        status === 'FLAGGED'
          ? ['Sanctions']
          : status === 'IN_REVIEW'
            ? ['PEP']
            : [],
      providerRequestId: `stubaml_${randomUUID()}`,
      status,
      topRiskScore:
        status === 'FLAGGED' ? 100 : status === 'IN_REVIEW' ? 85 : 0,
      totalHits: hit ? 1 : 0,
    };
  }
}

function refRequiresAml(providerRef: string): boolean {
  // ref is `stubkyc_<PURPOSE>_<uuid>`; PURPOSE itself contains an underscore, so match by
  // substring rather than positional split.
  return (
    providerRef.includes('CAMPAIGN_CREATOR') ||
    providerRef.includes('BACKER_THRESHOLD') ||
    providerRef.includes('BUSINESS_VERIFICATION')
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
    case 'In Progress':
      return 'PENDING';
    default:
      return 'VERIFIED';
  }
}

function diditLabelFor(status: KycOutcome): DiditStatus {
  if (status === 'VERIFIED') return 'Approved';
  if (status === 'REJECTED') return 'Declined';
  if (status === 'IN_REVIEW') return 'In Review';
  return 'In Progress';
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
