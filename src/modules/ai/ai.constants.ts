export const AI_ASSISTANT_FEATURE = 'ai.assistant';

export const IDEA_ASSISTANT_ACTIONS = [
  'improve',
  'shorten',
  'expand',
  'critique',
] as const;
export type IdeaAssistantAction = (typeof IDEA_ASSISTANT_ACTIONS)[number];

/** Fields the idea builder can ask the assistant to work on. */
export const IDEA_ASSISTANT_FIELDS = [
  'title',
  'summary',
  'problem',
  'targetUser',
  'currentAlternative',
  'solution',
  'risks',
] as const;
export type IdeaAssistantField = (typeof IDEA_ASSISTANT_FIELDS)[number];

/** Context keys accepted alongside the target text. */
export const IDEA_ASSISTANT_CONTEXT_FIELDS = IDEA_ASSISTANT_FIELDS;

export const IDEA_ASSISTANT_PROMPT_VERSION = 'idea-assistant.v1';
