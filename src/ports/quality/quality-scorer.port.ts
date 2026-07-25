// Port: idea quality scorer (FR-271). The port is the committed contract; the stub
// adapter does deterministic completeness checks, a future Claude adapter adds the
// AI checks (thin-content, near-duplicate, ask<->roadmap coherence). Output is
// COACHING, never a rejection (FR-271a) — the caller decides tier, never blocks publish.

export type QualityCheckKind = 'deterministic' | 'ai';

export interface QualityCheck {
  id: string; // e.g. 'targetUser.present'
  passed: boolean;
  weight: number; // contribution to the score (0..1 of total)
  kind: QualityCheckKind;
  message: string; // creator-facing coaching line
}

export interface QualityReport {
  score: number; // 0..1 weighted pass ratio over evaluated checks
  checks: QualityCheck[];
  // A skipped AI check (stub adapter) is reported but excluded from the score.
  skipped: string[];
}

// The idea content a scorer needs — decoupled from the Prisma model.
export interface ScorableIdea {
  title: string;
  problem: string;
  solution: string;
  targetUser?: string | null;
  currentAlternative?: string | null;
  askBreakdown?: unknown;
  roadmapSteps?: unknown;
  category?: string | null;
}

export interface QualityScorerPort {
  score(idea: ScorableIdea): Promise<QualityReport>;
}

export const QUALITY_SCORER_PORT = Symbol('QUALITY_SCORER_PORT');
