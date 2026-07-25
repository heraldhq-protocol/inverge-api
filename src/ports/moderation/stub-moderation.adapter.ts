import { Injectable } from '@nestjs/common';
import {
  CategoryFinding,
  ModeratableContent,
  ModerationClassifierPort,
  ModerationResult,
  PolicyCode,
  summarize,
} from './moderation.port';

// Offline deterministic classifier (FR-1003). Tuned for recall over precision (NFR-18)
// on the two launch-critical categories (POL-SEC, POL-CAT) — it flags for admin review,
// it never blocks. A Claude/DeepSeek adapter replaces it for nuanced/euphemistic cases.
@Injectable()
export class StubModerationAdapter implements ModerationClassifierPort {
  async classify(content: ModeratableContent): Promise<ModerationResult> {
    return Promise.resolve(keywordClassify(content));
  }
}

// term -> weight; presence accumulates risk (capped at 1) and captures an excerpt.
const RULES: Record<PolicyCode, { term: RegExp; weight: number }[]> = {
  'POL-SEC': [
    { term: /\bguaranteed?\s+(returns?|profits?|income)\b/i, weight: 0.7 },
    { term: /\b(roi|return on investment|profit\s*share|dividends?|equity stake)\b/i, weight: 0.5 },
    { term: /\b\d+\s*%\s*(returns?|apy|apr|monthly|annually|per month)\b/i, weight: 0.6 },
    { term: /\b(\d+x)\s+(your (money|investment)|returns?)\b/i, weight: 0.6 },
    { term: /\byour money works for you\b/i, weight: 0.4 },
    { term: /\b(invest(ors?)?|investment opportunity)\b/i, weight: 0.25 },
  ],
  'POL-CAT': [
    { term: /\b(weapons?|firearms?|ammunition|guns?)\b/i, weight: 0.7 },
    { term: /\b(gambling|casino|betting|lottery)\b/i, weight: 0.6 },
    { term: /\b(token launch|ico|initial coin offering|meme\s*coin|presale of \w+ token)\b/i, weight: 0.6 },
    { term: /\b(mlm|multi-?level marketing|pyramid scheme|downline)\b/i, weight: 0.7 },
    { term: /\b(cure|cures|treats?)\s+(cancer|covid|hiv|diabetes)\b/i, weight: 0.7 },
  ],
  'POL-MIS': [
    { term: /\b(guaranteed|100%|risk[-\s]?free|no risk)\b/i, weight: 0.4 },
    { term: /\b(partnered with|backed by|endorsed by)\s+[A-Z]/, weight: 0.3 },
  ],
  'POL-FRD': [
    { term: /\b(fake|fabricated|too good to be true)\b/i, weight: 0.3 },
  ],
  'POL-IP': [
    { term: /\b(official|licensed)\s+(nike|apple|disney|coca-?cola)\b/i, weight: 0.6 },
  ],
  'POL-AML': [
    { term: /\b(structuring|mixer|tumbler|launder)\b/i, weight: 0.7 },
  ],
};

export function keywordClassify(content: ModeratableContent): ModerationResult {
  const text = `${content.title ?? ''}\n${content.text}`;
  const categories: CategoryFinding[] = [];

  for (const code of Object.keys(RULES) as PolicyCode[]) {
    let risk = 0;
    let excerpt: string | null = null;
    for (const { term, weight } of RULES[code]) {
      const m = text.match(term);
      if (m) {
        risk += weight;
        if (!excerpt) excerpt = m[0];
      }
    }
    if (risk > 0) {
      categories.push({
        code,
        riskScore: Math.min(1, Math.round(risk * 1e4) / 1e4),
        excerpt,
        draftReason: draftReasonFor(code),
      });
    }
  }

  return summarize(categories, 'stub');
}

function draftReasonFor(code: PolicyCode): string {
  switch (code) {
    case 'POL-SEC':
      return 'Your pitch implies a financial return to backers. Inverge validation is reward/interest-based only — reframe without ROI, profit, or investment language.';
    case 'POL-CAT':
      return 'Your idea appears to fall in a prohibited category. Please review the content guidelines.';
    case 'POL-MIS':
      return 'Some claims may need evidence. Remove or substantiate guarantees and unverified endorsements.';
    default:
      return 'This submission was flagged for review against our content policy.';
  }
}
