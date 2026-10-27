// Port: KYC + AML provider (FR-103-105). Selected by KYC_PROVIDER env: 'stub' (offline dev)
// or 'didit'. One provider serves both products - the *purpose* picks which verification
// runs: identity-only for idea-validation credibility (grants the VERIFIED pre-pledge tier),
// identity + AML for anyone who will handle funds (campaign creators, threshold backers).
//
// The port deliberately carries no raw provider payload. Adapters reduce the provider
// response to the fields Inverge is allowed to keep (status, feature codes, warning codes,
// AML aggregates). Identity documents, selfies and full reports never cross this boundary.

import type { DiditStatus } from '../../modules/kyc/verification-status';

// What a verification session is for. Drives which provider workflow runs and whether AML
// screening is part of it. BUSINESS_VERIFICATION runs Didit KYB (registry + documents +
// directors/UBOs + AML) for a company, rather than an individual's identity.
export type KycPurpose =
  | 'IDEA_VALIDATION'
  | 'CAMPAIGN_CREATOR'
  | 'BACKER_THRESHOLD'
  | 'BUSINESS_VERIFICATION';

export const KYC_PURPOSES: readonly KycPurpose[] = [
  'IDEA_VALIDATION',
  'CAMPAIGN_CREATOR',
  'BACKER_THRESHOLD',
  'BUSINESS_VERIFICATION',
];

// Purposes that require AML screening (they let a user/entity handle money). KYB always
// screens the business, so BUSINESS_VERIFICATION is included.
export function purposeRequiresAml(purpose: KycPurpose): boolean {
  return (
    purpose === 'CAMPAIGN_CREATOR' ||
    purpose === 'BACKER_THRESHOLD' ||
    purpose === 'BUSINESS_VERIFICATION'
  );
}

// Normalized identity-verification outcome (provider statuses mapped onto our vocabulary).
export type KycOutcome = 'VERIFIED' | 'REJECTED' | 'PENDING' | 'IN_REVIEW';

// Normalized AML outcome. null = the workflow ran no AML step (identity-only session).
export type AmlOutcome = 'CLEAR' | 'IN_REVIEW' | 'FLAGGED';

export interface StartVerificationParams {
  /** Stable provider grouping key: the user id for KYC, the business id for KYB. */
  vendorData: string;
  purpose: KycPurpose;
  callbackUrl?: string; // where the user returns after finishing
  email?: string; // optional pre-fill
  language?: string; // ISO 639-1; auto-detected if omitted
  /** Pre-fills the KYB registry search. Person fields are ignored by KYB. */
  business?: {
    legalName: string;
    registrationNumber?: string;
    country?: string;
    businessType?: string;
  };
}

export interface StartVerificationResult {
  providerRef: string; // session id at the provider
  verificationUrl: string; // hosted flow the user opens
  sessionKind: 'user' | 'business' | null;
  workflowId?: string | null;
}

export interface AmlSummary {
  totalHits: number;
  topRiskScore: number | null; // highest risk score among non-false-positive hits
  datasets: string[]; // e.g. ['Sanctions', 'PEP', 'Adverse Media']
}

export interface KycDecision {
  providerRef: string;
  /** Internal vocabulary, retained for the legacy /kyc projections. */
  status: KycOutcome;
  /** Exact provider label, retained for support and mapping audits. */
  providerStatus: DiditStatus | null;
  aml: AmlOutcome | null; // null when no AML step ran
  amlSummary: AmlSummary | null;
  /** Provider feature codes reported by the decision (no personal data). */
  features: string[];
  /** Warning / decline reason codes (no free-text personal data). */
  warningCodes: string[];
  decisionId: string | null;
  createdAt: string | null;
}

// The trustable payload of a *verified* webhook: enough to identify the session and
// know the reported status. The service re-derives full AML detail from getDecision().
export interface KycWebhookEvent {
  providerRef: string;
  vendorData: string | null;
  status: KycOutcome;
  providerStatus: DiditStatus | null;
  aml: AmlOutcome | null;
  eventId: string | null;
  webhookType: string | null;
  occurredAt: Date | null;
  /** KYB payloads identify the business session separately. */
  businessEntityRef: string | null;
  /** False when only the deprecated envelope signature verified. */
  payloadAuthenticated: boolean;
}

export interface AmlScreeningParams {
  fullName: string;
  dateOfBirth?: string; // YYYY-MM-DD
  nationality?: string; // ISO alpha-2 / alpha-3
  documentNumber?: string; // "golden key" - sharpens matching
  entityType?: 'person' | 'company';
  vendorData?: string;
  includeAdverseMedia?: boolean;
  includeOngoingMonitoring?: boolean;
}

export interface AmlScreeningResult {
  status: AmlOutcome;
  totalHits: number;
  topRiskScore: number | null;
  datasets: string[];
  providerRequestId: string | null;
}

export interface KycProviderPort {
  // Start a hosted identity (+AML, per purpose) verification for a user.
  startVerification(params: StartVerificationParams): Promise<StartVerificationResult>;

  // Authoritative decision fetch - used after a webhook fires, or when polling.
  getDecision(providerRef: string): Promise<KycDecision>;

  // Verify a webhook (signature + freshness) and normalize it. Returns null when the body is
  // malformed or the signature does not verify - callers MUST treat null as "reject".
  parseWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): KycWebhookEvent | null;

  // Standalone AML screening (ad-hoc / ongoing monitoring), independent of a KYC session.
  screenAml(params: AmlScreeningParams): Promise<AmlScreeningResult>;
}

export const KYC_PROVIDER_PORT = Symbol('KYC_PROVIDER_PORT');
