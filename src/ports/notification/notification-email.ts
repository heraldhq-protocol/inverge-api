import type { EmailTemplateId } from '../../common/email';
import type { NotificationMessage } from './notification.port';

export interface NotificationEmailMapping {
  templateId: EmailTemplateId;
  variables: Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Copies only the keys a template declares. Notification `data` is internal, so
 * an unknown key must never reach the renderer, and an unknown notification
 * template falls back to generic copy instead of leaking its name.
 */
function variables(
  data: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of keys) {
    const value = asString(data[key]);
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

const IDEA_KEYS = ['ideaId', 'ideaTitle'] as const;
const CAMPAIGN_KEYS = ['campaignId', 'campaignTitle'] as const;

export function notificationEmailTemplate(
  message: NotificationMessage,
): NotificationEmailMapping {
  switch (message.template) {
    case 'WAITLIST_CONVERSION':
      return {
        templateId: 'WAITLIST_IDEA_LIVE',
        variables: variables(message.data, ['ideaId', 'ideaTitle', 'campaignId']),
      };
    case 'CAMPAIGN_FUNDED':
      return {
        templateId: 'CAMPAIGN_FUNDED',
        variables: variables(message.data, CAMPAIGN_KEYS),
      };
    case 'MILESTONE_REVIEW':
    case 'MILESTONE_OBJECTION_WINDOW':
      return {
        templateId: 'MILESTONE_REVIEW',
        variables: variables(message.data, ['campaignId', 'milestoneTitle']),
      };
    case 'IDEA_PUBLISHED':
      return {
        templateId: 'IDEA_PUBLISHED',
        variables: variables(message.data, IDEA_KEYS),
      };
    case 'IDEA_FEEDBACK':
      return {
        templateId: 'IDEA_FEEDBACK',
        variables: variables(message.data, IDEA_KEYS),
      };
    case 'IDEA_COMMENT':
      return {
        templateId: 'IDEA_COMMENT',
        variables: variables(message.data, [...IDEA_KEYS, 'kind']),
      };
    case 'CAMPAIGN_SUBMITTED':
      return {
        templateId: 'CAMPAIGN_SUBMITTED',
        variables: variables(message.data, CAMPAIGN_KEYS),
      };
    case 'CAMPAIGN_APPROVED':
      return {
        templateId: 'CAMPAIGN_APPROVED',
        variables: variables(message.data, CAMPAIGN_KEYS),
      };
    case 'CAMPAIGN_CHANGES_REQUESTED':
      return {
        templateId: 'CAMPAIGN_CHANGES_REQUESTED',
        variables: variables(message.data, CAMPAIGN_KEYS),
      };
    case 'CAMPAIGN_PUBLISHED':
      return {
        templateId: 'CAMPAIGN_PUBLISHED',
        variables: variables(message.data, CAMPAIGN_KEYS),
      };
    case 'KYC_APPROVED':
    case 'KYC_DECLINED':
    case 'KYC_ACTION_REQUIRED':
    case 'AML_REVIEW':
    case 'AML_CLEAR':
      return { templateId: message.template, variables: {} };
    case 'PROGRAMME_REGISTERED':
    case 'PROGRAMME_ENTRY_SUBMITTED':
    case 'PROGRAMME_ENTRY_DECISION':
    case 'PROGRAMME_RESULTS_PUBLISHED':
    case 'PROGRAMME_WINNER':
      return {
        templateId: message.template,
        variables: variables(message.data, [
          'programmeTitle',
          'programmeSlug',
          'entryTitle',
          'status',
          'rank',
          'officialScore',
          'feedback',
          'prize',
          'submissionClosesAt',
          'judgingEndsAt',
          'version',
        ]),
      };
    default:
      // No template name and no data: a safe generic message, never a leak.
      return { templateId: 'ACCOUNT_UPDATE', variables: {} };
  }
}
