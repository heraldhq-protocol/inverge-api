import { z } from 'zod';
import type { IdeaAssistantAction } from '../ai.constants';

const shortText = z.string().trim().min(1).max(240);

export const ideaAssistantOutputSchema = z.object({
  proposal: z.string().trim().max(1_500).nullable(),
  notes: z.array(shortText).max(5).default([]),
  assumptions: z.array(shortText).max(4).default([]),
});

export type IdeaAssistantOutput = z.infer<typeof ideaAssistantOutputSchema>;

export type IdeaAssistantParseResult =
  | { ok: true; value: IdeaAssistantOutput }
  | { ok: false; reason: string };

/**
 * Defensive parse: models wrap JSON in prose or fences, and a critique must not
 * smuggle a replacement. Pure so the failure modes are unit-tested without a
 * provider.
 */
export function parseIdeaAssistantOutput(
  text: string,
  action: IdeaAssistantAction,
): IdeaAssistantParseResult {
  const json = extractJsonObject(text);
  if (!json) return { ok: false, reason: 'No JSON object in the response' };

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'Response was not valid JSON' };
  }

  const parsed = ideaAssistantOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'Response did not match the proposal schema' };
  }

  const value = parsed.data;

  if (action === 'critique') {
    if (value.notes.length === 0) {
      return { ok: false, reason: 'A critique returned no notes' };
    }
    return { ok: true, value: { ...value, proposal: null } };
  }

  if (!value.proposal || value.proposal.length === 0) {
    return { ok: false, reason: 'A rewrite returned no proposal' };
  }

  return { ok: true, value };
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return body.slice(start, end + 1);
}
