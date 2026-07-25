import { Injectable } from '@nestjs/common';
import {
  QualityCheck,
  QualityReport,
  QualityScorerPort,
  ScorableIdea,
} from './quality-scorer.port';

// AI-only checks the deterministic adapter cannot perform; reported as skipped and
// excluded from the score. A Claude adapter would implement these.
const AI_CHECKS = [
  'content.substantive', // thin-content detection
  'content.original', // duplicate / plagiarism
  'ask.coherence', // ask <-> roadmap coherence
];

// Deterministic completeness scorer (FR-271, Phase 0). No AI — it checks the structured
// pitch is filled in with substance, and REPORTS (does not run) the AI-only checks a
// Claude adapter would add. Output is coaching (FR-271a): the caller decides the tier.
@Injectable()
export class StubQualityScorerAdapter implements QualityScorerPort {
  async score(idea: ScorableIdea): Promise<QualityReport> {
    return Promise.resolve(scoreCompleteness(idea));
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const hasLen = (v: unknown, min: number): boolean => str(v).length >= min;

function isNonEmptyBreakdown(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v as object).length > 0;
  return false;
}

function datedSteps(v: unknown): number {
  if (!Array.isArray(v)) return 0;
  return v.filter(
    (s) => s && typeof s === 'object' && hasLen((s as any).date, 1) && hasLen((s as any).description, 1),
  ).length;
}

// Pure, unit-testable. Six equally-weighted deterministic checks; score = passed ratio.
export function scoreCompleteness(idea: ScorableIdea): QualityReport {
  const checks: QualityCheck[] = [
    {
      id: 'targetUser.specific',
      passed: hasLen(idea.targetUser, 10),
      weight: 1 / 6,
      kind: 'deterministic',
      message: 'Name a specific target user (not "everyone") — ideas that do attract more supporters.',
    },
    {
      id: 'currentAlternative.present',
      passed: hasLen(idea.currentAlternative, 20),
      weight: 1 / 6,
      kind: 'deterministic',
      message: 'Explain what the user does today and why it falls short.',
    },
    {
      id: 'askBreakdown.present',
      passed: isNonEmptyBreakdown(idea.askBreakdown),
      weight: 1 / 6,
      kind: 'deterministic',
      message: 'Give an indicative breakdown of what the ask will buy.',
    },
    {
      id: 'roadmap.datedSteps',
      passed: datedSteps(idea.roadmapSteps) >= 2,
      weight: 1 / 6,
      kind: 'deterministic',
      message: 'Provide at least two dated roadmap steps.',
    },
    {
      id: 'problem.substance',
      passed: hasLen(idea.problem, 20),
      weight: 1 / 6,
      kind: 'deterministic',
      message: 'Describe the problem in more detail.',
    },
    {
      id: 'solution.substance',
      passed: hasLen(idea.solution, 20),
      weight: 1 / 6,
      kind: 'deterministic',
      message: 'Describe the solution in more detail.',
    },
  ];

  const score = checks.reduce((acc, c) => acc + (c.passed ? c.weight : 0), 0);
  return {
    score: Math.round(score * 1e4) / 1e4,
    checks,
    skipped: [...AI_CHECKS],
  };
}
