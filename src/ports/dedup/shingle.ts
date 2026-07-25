// Pure text-similarity helpers for near-duplicate detection (no I/O, unit-testable).
// Word-trigram shingling + Jaccard — cheap, deterministic, and language-agnostic enough
// for Phase 0. A semantic (embedding/LLM) adapter can replace the port later.

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// Word k-grams as a set. For texts shorter than k words, fall back to the individual
// words so very short pitches still produce comparable shingles.
export function shingles(text: string, k = 3): Set<string> {
  const words = normalize(text).split(' ').filter(Boolean);
  if (words.length === 0) return new Set();
  if (words.length < k) return new Set(words);
  const out = new Set<string>();
  for (let i = 0; i <= words.length - k; i++) out.add(words.slice(i, i + k).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : Math.round((inter / union) * 1e4) / 1e4;
}

export function similarity(textA: string, textB: string): number {
  return jaccard(shingles(textA), shingles(textB));
}
