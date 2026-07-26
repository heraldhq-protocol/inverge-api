import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
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

// Didit KYC/AML adapter (FR-103–105). Talks to the Didit v3 API with an x-api-key.
//   - Sessions: POST /session/ (hosted ID + liveness + face match [+ AML]) → user gets a URL.
//   - Decision: GET /session/{id}/decision/ — the authoritative outcome (we re-fetch this on
//     every webhook so a spoofed/unsigned callback can never set a false status).
//   - Webhook: HMAC-SHA256 signature + timestamp freshness (defense in depth).
//   - AML: POST /aml/ — standalone sanctions/PEP/adverse-media screen for ongoing monitoring.
// Which workflow runs is chosen by purpose: identity-only vs identity+AML.
@Injectable()
export class DiditKycAdapter implements KycProviderPort {
  private readonly logger = new Logger(DiditKycAdapter.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  private get baseUrl(): string {
    return this.config.get('DIDIT_BASE_URL', { infer: true }).replace(/\/$/, '');
  }

  private get apiKey(): string {
    const key = this.config.get('DIDIT_API_KEY', { infer: true });
    if (!key) throw new Error('DIDIT_API_KEY is not configured');
    return key;
  }

  private workflowFor(purpose: KycPurpose): string {
    const key = purposeRequiresAml(purpose)
      ? 'DIDIT_KYC_AML_WORKFLOW_ID'
      : 'DIDIT_KYC_WORKFLOW_ID';
    const id = this.config.get(key as any, { infer: true }) as string | undefined;
    if (!id) throw new Error(`${key} is not configured (needed for purpose ${purpose})`);
    return id;
  }

  async startVerification(
    params: StartVerificationParams,
  ): Promise<StartVerificationResult> {
    const body: Record<string, unknown> = {
      workflow_id: this.workflowFor(params.purpose),
      vendor_data: params.userId,
    };
    if (params.callbackUrl) body.callback = params.callbackUrl;
    if (params.language) body.language = params.language;
    if (params.email) body.contact_details = { email: params.email };

    const res = await this.request<any>('POST', '/session/', body);
    const providerRef = res.session_id ?? res.session_token;
    if (!providerRef || !res.url) {
      throw new Error('Didit session response missing session_id/url');
    }
    return { providerRef, verificationUrl: res.url };
  }

  async getDecision(providerRef: string): Promise<KycDecision> {
    const res = await this.request<any>(
      'GET',
      `/session/${encodeURIComponent(providerRef)}/decision/`,
    );
    const status = mapKycStatus(res.status);
    const aml = extractAml(res);
    return {
      providerRef,
      status,
      aml: aml?.outcome ?? null,
      amlSummary: aml?.summary ?? null,
      raw: res,
    };
  }

  parseWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): KycWebhookEvent | null {
    if (!this.verifySignature(rawBody, headers)) return null;
    let evt: any;
    try {
      evt = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const providerRef = evt?.session_id ?? evt?.session?.session_id;
    if (!providerRef) return null;
    const aml = evt?.decision ? extractAml(evt.decision) : null;
    return {
      providerRef,
      vendorData: evt?.vendor_data ?? evt?.decision?.vendor_data ?? null,
      status: mapKycStatus(evt?.status ?? evt?.decision?.status),
      aml: aml?.outcome ?? null,
    };
  }

  async screenAml(params: AmlScreeningParams): Promise<AmlScreeningResult> {
    const body: Record<string, unknown> = {
      full_name: params.fullName,
      entity_type: params.entityType ?? 'person',
    };
    if (params.dateOfBirth) body.date_of_birth = params.dateOfBirth;
    if (params.nationality) body.nationality = params.nationality;
    if (params.documentNumber) body.document_number = params.documentNumber;
    if (params.vendorData) body.vendor_data = params.vendorData;

    const res = await this.request<any>('POST', '/aml/', body);
    const aml = extractAml(res) ?? {
      outcome: 'CLEAR' as AmlOutcome,
      summary: { totalHits: 0, topRiskScore: 0, datasets: [] },
    };
    return {
      status: aml.outcome,
      totalHits: aml.summary.totalHits,
      topRiskScore: aml.summary.topRiskScore,
      datasets: aml.summary.datasets,
      raw: res,
    };
  }

  // ── Webhook signature verification ────────────────────────────────────────────────
  // Accepts any Didit signature scheme whose header is present: raw-body HMAC (x-signature),
  // canonical V2 (x-signature-v2), or simple (x-signature-simple). If no secret is configured
  // we cannot verify — allow (dev) but warn. With a secret, a present-but-mismatched signature
  // is rejected; the service still re-fetches the decision authoritatively regardless.
  verifySignature(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): boolean {
    const secret = this.config.get('DIDIT_WEBHOOK_SECRET', { infer: true });
    if (!secret) {
      this.logger.warn('DIDIT_WEBHOOK_SECRET unset — skipping webhook signature check');
      return true;
    }
    const h = lower(headers);
    const timestamp = h['x-timestamp'];
    if (timestamp && Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
      this.logger.warn('Didit webhook timestamp outside tolerance');
      return false;
    }

    const sig = h['x-signature'];
    const sigV2 = h['x-signature-v2'];
    const sigSimple = h['x-signature-simple'];
    if (!sig && !sigV2 && !sigSimple) {
      this.logger.warn('Didit webhook has no signature header');
      return false;
    }

    if (sig && hmacEq(secret, rawBody, sig)) return true;
    if (sigV2 && timestamp) {
      const canonical = canonicalize(safeParse(rawBody));
      if (hmacEq(secret, `${timestamp}:${canonical}`, sigV2)) return true;
    }
    if (sigSimple && timestamp) {
      const b = safeParse(rawBody) as any;
      const msg = `${timestamp}:${b?.session_id}:${b?.status}:${b?.webhook_type}`;
      if (hmacEq(secret, msg, sigSimple)) return true;
    }
    this.logger.warn('Didit webhook signature did not verify');
    return false;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'x-api-key': this.apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Didit ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

// ── pure mappers (exported for unit tests) ────────────────────────────────────────────

export function mapKycStatus(s: unknown): KycOutcome {
  switch (String(s)) {
    case 'Approved':
      return 'VERIFIED';
    case 'Declined':
      return 'REJECTED';
    case 'In Review':
      return 'IN_REVIEW';
    default: // Not Started | In Progress | Expired | Abandoned | ...
      return 'PENDING';
  }
}

export function mapAmlStatus(s: unknown): AmlOutcome {
  switch (String(s)) {
    case 'Approved':
      return 'CLEAR';
    case 'In Review':
      return 'IN_REVIEW';
    case 'Rejected':
    case 'Declined':
      return 'FLAGGED';
    default:
      return 'CLEAR';
  }
}

// Pulls an AML block out of either a standalone /aml/ response, a session decision, or a
// webhook decision. Handles the object shape ({aml:{...}}) and the array shape
// ({aml_screenings:[...]}). Returns null when there is no AML data at all.
export function extractAml(
  source: any,
): { outcome: AmlOutcome; summary: AmlSummary } | null {
  if (!source || typeof source !== 'object') return null;
  let block: any = null;
  if (source.aml && typeof source.aml === 'object') block = source.aml;
  else if (Array.isArray(source.aml_screenings) && source.aml_screenings.length) {
    block = source.aml_screenings[0];
  } else if (Array.isArray(source.aml_screenings)) {
    return null; // ran, but empty — treated as "no AML data" (identity-only path)
  }
  if (!block) return null;

  const hits: any[] = Array.isArray(block.hits) ? block.hits : [];
  const realHits = hits.filter((x) => x?.review_status !== 'False Positive');
  const datasets = uniq(
    (realHits.length ? realHits : hits).flatMap((x) =>
      Array.isArray(x?.datasets) ? x.datasets : [],
    ),
  );
  const riskScores = realHits
    .map((x) => Number(x?.risk_score))
    .filter((n) => Number.isFinite(n));
  const topRiskScore = riskScores.length
    ? Math.max(...riskScores)
    : typeof block.score === 'number'
      ? block.score
      : null;

  return {
    outcome: mapAmlStatus(block.status),
    summary: {
      totalHits: typeof block.total_hits === 'number' ? block.total_hits : hits.length,
      topRiskScore,
      datasets,
    },
  };
}

function hmacEq(secret: string, message: string, given: string): boolean {
  const expected = createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function canonicalize(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function lower(h: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, val] of Object.entries(h)) out[k.toLowerCase()] = val;
  return out;
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
