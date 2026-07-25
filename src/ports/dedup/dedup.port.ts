// Port: near-duplicate idea detector (FR-1003 / FR-271 duplicate detection). The stub
// adapter does deterministic shingle similarity; a semantic (embedding/LLM) adapter can
// drop in later. Output is advisory — the moderation harness decides whether to hold.

export interface DuplicateCandidate {
  text: string; // combined pitch text to compare
  excludeIdeaId?: string; // don't match the idea against itself
}

export interface DuplicateMatch {
  ideaId: string;
  title: string;
  similarity: number; // 0..1
}

export interface DuplicateDetectorPort {
  // Returns near-duplicate ideas, most-similar first (may be empty).
  findSimilar(candidate: DuplicateCandidate): Promise<DuplicateMatch[]>;
}

export const DUPLICATE_DETECTOR_PORT = Symbol('DUPLICATE_DETECTOR_PORT');
