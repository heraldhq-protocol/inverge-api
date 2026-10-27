import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import {
  AmlOutcome,
  AmlScreeningParams,
  AmlScreeningResult,
  AmlSummary,
  KycDecision,
  KycOutcome,
  KycProviderPort,
  KycPurpose,
  KycWebhookEvent,
  purposeRequiresAml,
  StartVerificationParams,
  StartVerificationResult,
} from './kyc-provider.port';
import {
  legacyOutcomeForState,
  mapDiditStatus,
} from '../../modules/kyc/verification-status';
import {
  parseDiditEnvelope,
  verifyDiditSignature,
} from '../../modules/kyc/didit-webhook-verifier';

// Didit adapter (FR-103-105). Current API: https://verification.didit.me/v3
//   POST /session/                       create a hosted KYC or KYB session
//   GET  /session/{id}/decision/         authoritative decision
//   POST /aml/                           standalone sanctions/PEP/adverse-media screen
//
// The adapter is the only place that knows Didit's payload shape. It reduces every
// response to the port's summary types: identity documents, selfies, presigned media
// URLs and full provider reports never cross this boundary and are never logged.

const REQUEST_TIMEOUT_MS = 10_000;

interface DiditSessionResponse {
  session_id?: unknown;
  session_kind?: unknown;
  url?: unknown;
}

export interface ExtractedAml {
  outcome: AmlOutcome;
  summary: AmlSummary;
}

@Injectable()
export class DiditKycAdapter implements KycProviderPort {
  private readonly logger = new Logger(DiditKycAdapter.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  private get baseUrl(): string {
    return this.config
      .get('DIDIT_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  private get apiKey(): string {
    const key = this.config.get('DIDIT_API_KEY', { infer: true });
    if (!key) throw new Error('DIDIT_API_KEY is not configured');
    return key;
  }

  private workflowFor(purpose: KycPurpose): string {
    const key =
      purpose === 'BUSINESS_VERIFICATION'
        ? 'DIDIT_KYB_WORKFLOW_ID'
        : purposeRequiresAml(purpose)
          ? 'DIDIT_KYC_AML_WORKFLOW_ID'
          : 'DIDIT_KYC_WORKFLOW_ID';
    const id = this.config.get(key, { infer: true });
    if (!id) throw new Error(`${key} is not configured (needed for purpose ${purpose})`);
    return id;
  }

  async startVerification(
    params: StartVerificationParams,
  ): Promise<StartVerificationResult> {
    const body: Record<string, unknown> = {
      workflow_id: this.workflowFor(params.purpose),
      vendor_data: params.vendorData,
      // Either device may return the user; the redirect is a hint, never proof.
      callback_method: 'both',
    };
    if (params.callbackUrl) body.callback = params.callbackUrl;
    if (params.language) body.language = params.language;
    if (params.email) body.contact_details = { email: params.email };

    if (params.purpose === 'BUSINESS_VERIFICATION' && params.business) {
      const expected: Record<string, string> = {
        company_name: params.business.legalName.slice(0, 255),
      };
      if (params.business.registrationNumber) {
        expected.registration_number =
          params.business.registrationNumber.slice(0, 100);
      }
      if (params.business.country) {
        // Didit expects ISO 3166-1 alpha-2, optionally with a state suffix.
        expected.registry_country = params.business.country
          .trim()
          .toUpperCase()
          .slice(0, 10);
      }
      body.expected_details = expected;
    }

    const res = await this.request<DiditSessionResponse>('POST', '/session/', body);
    const providerRef =
      typeof res.session_id === 'string' ? res.session_id : null;
    const verificationUrl = typeof res.url === 'string' ? res.url : null;
    if (!providerRef || !verificationUrl) {
      throw new Error('Didit session response missing session_id or url');
    }
    const sessionKind =
      res.session_kind === 'business'
        ? 'business'
        : res.session_kind === 'user'
          ? 'user'
          : null;

    return {
      providerRef,
      sessionKind,
      verificationUrl,
      workflowId:
        typeof (res as { workflow_id?: unknown }).workflow_id === 'string'
          ? ((res as { workflow_id: string }).workflow_id)
          : this.workflowFor(params.purpose),
    };
  }
  async getDecision(providerRef: string): Promise<KycDecision> {
    const res = await this.request<Record<string, unknown>>(
      'GET',
      `/session/${encodeURIComponent(providerRef)}/decision/`,
    );
    return extractDiditDecision(providerRef, res);
  }

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): KycWebhookEvent | null {
    const verdict = verifyDiditSignature({
      headers,
      rawBody,
      secret: this.config.get('DIDIT_WEBHOOK_SECRET', { infer: true }),
      previousSecret: this.config.get('DIDIT_WEBHOOK_SECRET_PREVIOUS', { infer: true }),
    });
    if (!verdict.ok) {
      this.logger.warn(`Didit webhook rejected: ${verdict.reason}`);
      return null;
    }

    const parsed = parseDiditEnvelope({
      payloadAuthenticated: verdict.authenticatesPayload,
      rawBody,
    });
    if (!parsed.ok) {
      this.logger.warn(`Didit webhook envelope rejected: ${parsed.reason}`);
      return null;
    }

    const event = parsed.event;
    const mapped = mapDiditStatus(event.status);
    const aml = event.decision ? extractAml(event.decision) : null;

    return {
      aml: aml?.outcome ?? null,
      businessEntityRef: event.vendorBusinessId,
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      payloadAuthenticated: verdict.authenticatesPayload,
      providerRef: event.sessionId,
      providerStatus: event.status,
      status: legacyOutcomeForState(mapped.state),
      vendorData: event.vendorData,
      webhookType: event.webhookType,
    };
  }

  async screenAml(params: AmlScreeningParams): Promise<AmlScreeningResult> {
    const body: Record<string, unknown> = {
      entity_type: params.entityType ?? 'person',
      full_name: params.fullName,
    };
    if (params.dateOfBirth) body.date_of_birth = params.dateOfBirth;
    if (params.nationality) body.nationality = params.nationality;
    if (params.documentNumber) body.document_number = params.documentNumber;
    if (params.vendorData) body.vendor_data = params.vendorData;
    if (params.includeAdverseMedia !== undefined) {
      body.include_adverse_media = params.includeAdverseMedia;
    }
    if (params.includeOngoingMonitoring !== undefined) {
      body.include_ongoing_monitoring = params.includeOngoingMonitoring;
    }

    const res = await this.request<Record<string, unknown>>('POST', '/aml/', body);
    const aml = extractAml(res);
    return {
      datasets: aml?.summary.datasets ?? [],
      providerRequestId:
        typeof res.request_id === 'string' ? res.request_id : null,
      status: aml?.outcome ?? 'IN_REVIEW',
      topRiskScore: aml?.summary.topRiskScore ?? null,
      totalHits: aml?.summary.totalHits ?? 0,
    };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        body: body ? JSON.stringify(body) : undefined,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          'x-api-key': this.apiKey,
        },
        method,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'network failure';
      throw new Error(`Didit ${method} ${path} unavailable: ${message}`);
    }

    const text = await response.text();
    if (!response.ok) {
      // Never echo the provider body: it can contain identity data. Status + a
      // short error code is enough for support and reconciliation.
      const retryAfter = response.headers.get('retry-after');
      throw new Error(
        `Didit ${method} ${path} failed with ${response.status}${
          retryAfter ? ` (retry-after ${retryAfter})` : ''
        }`,
      );
    }

    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Didit ${method} ${path} returned non-JSON`);
    }
  }
}

// ── pure extractors (exported for unit tests) ────────────────────────────────

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Collects stable warning codes from a decision or one feature report. */
export function extractWarningCodes(source: unknown): string[] {
  const codes = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = asObject(value);
    if (!record) return;
    for (const warning of asArray(record.warnings)) {
      const entry = asObject(warning);
      if (typeof entry?.risk === 'string' && entry.risk.length > 0) {
        codes.add(entry.risk);
      }
    }
  };
  visit(source);
  return [...codes].sort();
}

/**
 * Extracts the provider feature codes. V3 returns document-collection features as
 * `{ feature, node_id }` objects in `features[]`; other deployments return strings.
 */
export function extractFeatures(source: unknown): string[] {
  const record = asObject(source);
  if (!record) return [];
  const codes = new Set<string>();
  for (const entry of asArray(record.features)) {
    if (typeof entry === 'string' && entry.length > 0) codes.add(entry);
    else {
      const object = asObject(entry);
      if (typeof object?.feature === 'string') codes.add(object.feature);
    }
  }
  const featureKeys: Record<string, string> = {
    aml_screenings: 'AML',
    document_verifications: 'KYB_DOCUMENTS',
    face_matches: 'FACE_MATCH',
    id_verifications: 'ID_VERIFICATION',
    key_people_checks: 'KYB_KEY_PEOPLE',
    liveness_checks: 'LIVENESS',
    nfc_verifications: 'NFC',
    poa_verifications: 'PROOF_OF_ADDRESS',
    registry_checks: 'KYB_REGISTRY',
  };
  for (const [key, code] of Object.entries(featureKeys)) {
    if (asArray(record[key]).length > 0) codes.add(code);
  }
  return [...codes].sort();
}

/** Maps a Didit AML block (decision array item or standalone response). */
export function extractAml(source: unknown): ExtractedAml | null {
  const root = asObject(source);
  if (!root) return null;

  let block: Record<string, unknown> | null = null;
  if (Array.isArray(root.aml_screenings)) {
    if (root.aml_screenings.length === 0) return null;
    block = asObject(root.aml_screenings[0]);
  } else if (asObject(root.aml)) {
    block = asObject(root.aml);
  } else if (typeof root.status === 'string' && 'total_hits' in root) {
    block = root; // standalone /aml/ response
  }
  if (!block) return null;

  const hits = asArray(block.hits).map(asObject).filter(isPresent);
  const realHits = hits.filter((hit) => hit.review_status !== 'False Positive');
  const datasets = [
    ...new Set(
      (realHits.length ? realHits : hits).flatMap((hit) =>
        asArray(hit.datasets).filter(
          (dataset): dataset is string => typeof dataset === 'string',
        ),
      ),
    ),
  ].sort();

  const riskScores = realHits
    .map((hit) => Number(hit.risk_score))
    .filter((score) => Number.isFinite(score));
  const topRiskScore = riskScores.length
    ? Math.max(...riskScores)
    : typeof block.score === 'number'
      ? block.score
      : null;

  const status = String(block.status ?? '');
  const outcome: AmlOutcome =
    status === 'Approved'
      ? 'CLEAR'
      : status === 'In Review' || status === 'Declined'
        ? 'IN_REVIEW'
        : status === 'Rejected'
          ? 'FLAGGED'
          : hits.some((hit) => hit.review_status === 'Confirmed Match')
            ? 'FLAGGED'
            : 'IN_REVIEW';

  return {
    outcome,
    summary: {
      datasets,
      topRiskScore,
      totalHits:
        typeof block.total_hits === 'number'
          ? block.total_hits
          : hits.length,
    },
  };
}

/** Reduces the session decision to what Inverge may persist. */
export function extractDiditDecision(
  providerRef: string,
  source: unknown,
): KycDecision {
  const root = asObject(source) ?? {};
  const mapped = mapDiditStatus(root.status);
  const aml = extractAml(root);
  return {
    aml: aml?.outcome ?? null,
    amlSummary: aml?.summary ?? null,
    createdAt: typeof root.created_at === 'string' ? root.created_at : null,
    decisionId:
      typeof root.session_id === 'string' ? root.session_id : providerRef,
    features: extractFeatures(root),
    providerRef,
    providerStatus: mapped.providerStatus,
    status: legacyOutcomeForState(mapped.state),
    warningCodes: extractWarningCodes(root),
  };
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
