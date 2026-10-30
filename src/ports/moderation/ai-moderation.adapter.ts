import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { Env } from '../../config/env.validation';
import {
  CategoryFinding,
  ModeratableContent,
  ModerationClassifierPort,
  ModerationResult,
  POLICY_CODES,
  POLICY_SCOPE,
  PolicyCode,
  clampRisk,
  summarize,
} from './moderation.port';

// FR-1003 Layer 2 AI classifier. Uses the Anthropic SDK; AI_BASE_URL may point the
// client at a compatible endpoint (e.g. DeepSeek). AI_API_KEY, AI_BASE_URL and
// AI_MODEL are shared with the Creator Studio assistant. Output is off-chain flags
// only (NFR-17) and is tuned for recall over precision (NFR-18). Failures degrade
// to a review flag, never a block.
@Injectable()
export class AiModerationAdapter implements ModerationClassifierPort {
  private readonly logger = new Logger(AiModerationAdapter.name);
  private client: Anthropic | null = null;
  private readonly model: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.model = config.get('AI_MODEL', { infer: true });
  }

  private get anthropic(): Anthropic {
    if (!this.client) {
      const apiKey = this.config.get('AI_API_KEY', { infer: true });
      const baseURL = this.config.get('AI_BASE_URL', { infer: true });
      if (!apiKey) throw new Error('AI_API_KEY is not configured');
      this.client = new Anthropic({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
      });
    }
    return this.client;
  }

  async classify(content: ModeratableContent): Promise<ModerationResult> {
    const system = buildSystemPrompt();
    const user = `Classify this ${content.kind} submission.\n\nTITLE: ${content.title ?? ''}\n\nTEXT:\n${content.text}`;

    // Plain Messages call - no Claude-only params (thinking/effort/output_config), so it
    // stays compatible with non-Anthropic backends behind AI_BASE_URL.
    const res = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const categories = parseFindings(text);
    return summarize(categories, `ai:${this.model}`);
  }
}

function buildSystemPrompt(): string {
  const taxonomy = POLICY_CODES.map((c) => `- ${c}: ${POLICY_SCOPE[c]}`).join('\n');
  return [
    'You are a content policy classifier for Inverge, a crowdfunding idea-validation platform.',
    'Inverge is reward/interest-based and is NOT an investment platform: ANY implication of financial return to backers is a POL-SEC violation, including euphemisms.',
    '',
    'Screen the submission against this taxonomy and return findings:',
    taxonomy,
    '',
    'Tune for RECALL over precision: when uncertain, flag with a moderate score rather than clearing.',
    'Return ONLY a JSON array (no prose, no code fences). One object per category you find relevant:',
    '[{"code":"POL-SEC","riskScore":0.0-1.0,"excerpt":"<the triggering span or null>","draftReason":"<one creator-facing sentence>"}]',
    'If nothing is flagged, return [].',
  ].join('\n');
}

// Defensive parse: models may wrap the array in prose or code fences.
export function parseFindings(text: string): CategoryFinding[] {
  const json = extractJsonArray(text);
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const valid = new Set<string>(POLICY_CODES);
  const out: CategoryFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const code = (item as any).code as string;
    if (!valid.has(code)) continue;
    out.push({
      code: code as PolicyCode,
      riskScore: clampRisk((item as any).riskScore),
      excerpt: typeof (item as any).excerpt === 'string' ? (item as any).excerpt : null,
      draftReason: typeof (item as any).draftReason === 'string' ? (item as any).draftReason : '',
    });
  }
  return out;
}

function extractJsonArray(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  return body.slice(start, end + 1);
}
