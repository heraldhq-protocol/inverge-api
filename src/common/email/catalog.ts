import type { EmailCategory, EmailContent, EmailItem, EmailRenderContext } from './layout';

/**
 * Every outbound message the API can produce. The id is stored on
 * `EmailDelivery.template` and on persisted notifications, so renaming one is a
 * data migration, not a copy edit.
 */
export type EmailTemplateId =
  | 'VERIFICATION_CODE'
  | 'EMAIL_VERIFIED'
  | 'EMAIL_CHANGED'
  | 'IDEA_PUBLISHED'
  | 'IDEA_FEEDBACK'
  | 'IDEA_COMMENT'
  | 'WAITLIST_IDEA_LIVE'
  | 'ACCOUNT_UPDATE'
  | 'CAMPAIGN_SUBMITTED'
  | 'CAMPAIGN_APPROVED'
  | 'CAMPAIGN_CHANGES_REQUESTED'
  | 'CAMPAIGN_PUBLISHED'
  | 'CAMPAIGN_FUNDED'
  | 'MILESTONE_REVIEW'
  | 'KYC_APPROVED'
  | 'KYC_DECLINED'
  | 'KYC_ACTION_REQUIRED'
  | 'AML_REVIEW'
  | 'AML_CLEAR'
  | 'EDIT_INVERGE'
  | 'IDEA_OF_THE_WEEK'
  | 'EDITORS_PICK'
  | 'CREATOR_OF_THE_WEEK'
  | 'UPCOMING_COMPETITIONS'
  | 'CAMPAIGN_HIGHLIGHTS'
  | 'PLATFORM_ANNOUNCEMENT';

export type TemplateVariables = Record<string, unknown>;

export interface EmailTemplateDefinition {
  id: EmailTemplateId;
  category: EmailCategory;
  /** Human-facing label for the admin catalogue and docs. */
  label: string;
  requiredVariables: readonly string[];
  optionalVariables?: readonly string[];
  /** Domain checks beyond presence. Returns variable names, never values. */
  validate?(vars: TemplateVariables): string[];
  build(vars: TemplateVariables, ctx: EmailRenderContext): EmailContent;
}

function text(vars: TemplateVariables, key: string): string {
  const value = vars[key];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function itemList(vars: TemplateVariables, key: string): EmailItem[] | undefined {
  const value = vars[key];
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      title: typeof entry.title === 'string' ? entry.title.trim() : '',
      summary: typeof entry.summary === 'string' ? entry.summary.trim() : undefined,
      meta: typeof entry.meta === 'string' ? entry.meta.trim() : undefined,
      url: typeof entry.url === 'string' ? entry.url.trim() : undefined,
    }))
    .filter((entry) => entry.title.length > 0);
  return items.length > 0 ? items : undefined;
}

function appLink(ctx: EmailRenderContext, path: string): string {
  try {
    return new URL(path, ctx.appUrl).toString();
  } catch {
    return ctx.appUrl;
  }
}

function ideaLink(ctx: EmailRenderContext, vars: TemplateVariables): string {
  const id = text(vars, 'ideaId');
  return id ? appLink(ctx, `/ideas/${encodeURIComponent(id)}`) : appLink(ctx, '/ideas');
}

function campaignCreatorLink(ctx: EmailRenderContext, vars: TemplateVariables): string {
  const id = text(vars, 'campaignId');
  return id
    ? appLink(ctx, `/d/creator/campaigns/${encodeURIComponent(id)}`)
    : appLink(ctx, '/d/creator/campaigns');
}

const TRANSACTIONAL_REASON =
  'You received this because it relates to activity on your Inverge account.';
const EDITORIAL_REASON =
  'You are receiving this because you opted in to editorial email from Inverge.';

const verificationCode: EmailTemplateDefinition = {
  id: 'VERIFICATION_CODE',
  category: 'transactional',
  label: 'Email verification code',
  requiredVariables: ['code', 'expiresInMinutes', 'purpose'],
  validate(vars) {
    const problems: string[] = [];
    if (!/^\d{6}$/.test(text(vars, 'code'))) problems.push('code');
    const minutes = Number(text(vars, 'expiresInMinutes'));
    if (!Number.isInteger(minutes) || minutes <= 0) problems.push('expiresInMinutes');
    if (text(vars, 'purpose') !== 'SIGNUP' && text(vars, 'purpose') !== 'CHANGE') {
      problems.push('purpose');
    }
    return problems;
  },
  build(vars) {
    const changing = text(vars, 'purpose') === 'CHANGE';
    const minutes = text(vars, 'expiresInMinutes');
    return {
      subject: changing
        ? 'Confirm your new Inverge email address'
        : 'Your Inverge verification code',
      previewText: 'Use this code to confirm your email address. It expires shortly.',
      heading: changing ? 'Confirm your new email' : 'Confirm your email',
      paragraphs: [
        changing
          ? 'Use this code to confirm the new email address for your Inverge account.'
          : 'Use this code to confirm your email address and finish setting up your Inverge account.',
      ],
      code: {
        label: 'Verification code',
        value: text(vars, 'code'),
        hint: `This code expires in ${minutes} minutes and can be used once.`,
      },
      note: changing
        ? 'If you did not ask to change your email, ignore this message. Your current address stays in place until this code is entered. Inverge will never ask you for this code by phone or social media.'
        : 'If you did not create an Inverge account, ignore this message. Nothing changes until the code is entered. Inverge will never ask you for this code by phone or social media.',
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const verifiedEmail: EmailTemplateDefinition = {
  id: 'EMAIL_VERIFIED',
  category: 'transactional',
  label: 'Email address verified',
  requiredVariables: [],
  build(_vars, ctx) {
    return {
      subject: 'Your Inverge email is verified',
      previewText: 'Account and campaign updates can now reach this address.',
      heading: 'Your email is verified',
      paragraphs: [
        'Your Inverge account now has a verified email address. Account, campaign and escrow updates can reach you here.',
        'Identity verification and payment eligibility are separate steps. You can review their status in your account settings at any time.',
      ],
      cta: { label: 'Open account settings', url: appLink(ctx, '/d/settings') },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const changedEmail: EmailTemplateDefinition = {
  id: 'EMAIL_CHANGED',
  category: 'transactional',
  label: 'Email address changed (security alert)',
  requiredVariables: ['changedAt'],
  build(vars, ctx) {
    return {
      subject: 'Your Inverge email address was changed',
      previewText: 'The address on your account was replaced after verification.',
      heading: 'Your email address was changed',
      paragraphs: [
        'The email address on your Inverge account was changed after the new address was verified.',
        'This message went to the previous address so you are not locked out without warning.',
      ],
      details: [{ label: 'Changed', value: text(vars, 'changedAt') }],
      cta: { label: 'Review account security', url: appLink(ctx, '/d/settings') },
      note: 'If you did not make this change, contact support immediately. Your current address stays in place only until a new one is verified.',
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const ideaPublished: EmailTemplateDefinition = {
  id: 'IDEA_PUBLISHED',
  category: 'transactional',
  label: 'Idea published',
  requiredVariables: ['ideaTitle'],
  build(vars, ctx) {
    return {
      subject: `${text(vars, 'ideaTitle')} is live on Inverge`,
      previewText: 'Your idea is published and accepting supporters and feedback.',
      heading: 'Your idea is live',
      paragraphs: [
        `${text(vars, 'ideaTitle')} is now published and open for supporters, feedback and pre-pledges.`,
        'Validation is measured from confirmed activity, not from page views. Share the idea to start collecting real signals.',
      ],
      cta: { label: 'View your idea', url: ideaLink(ctx, vars) },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const ideaFeedback: EmailTemplateDefinition = {
  id: 'IDEA_FEEDBACK',
  category: 'transactional',
  label: 'New structured feedback',
  requiredVariables: ['ideaTitle'],
  build(vars, ctx) {
    return {
      subject: `New feedback on ${text(vars, 'ideaTitle')}`,
      previewText: 'A supporter answered your idea survey.',
      heading: 'New feedback received',
      paragraphs: [
        `Someone completed the feedback form on ${text(vars, 'ideaTitle')}.`,
        'Feedback counts toward validation only after the response is stored; you can review the response in your creator workspace.',
      ],
      cta: { label: 'Review feedback', url: ideaLink(ctx, vars) },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const ideaComment: EmailTemplateDefinition = {
  id: 'IDEA_COMMENT',
  category: 'transactional',
  label: 'New comment or reply',
  requiredVariables: ['ideaTitle'],
  build(vars, ctx) {
    const reply = text(vars, 'kind') === 'REPLY';
    return {
      subject: `${reply ? 'New reply' : 'New comment'} on ${text(vars, 'ideaTitle')}`,
      previewText: 'Open the idea to read the comment and reply.',
      heading: reply ? 'You have a new reply' : 'New comment on your idea',
      paragraphs: [
        `${reply ? 'Someone replied in the discussion on' : 'Someone commented on'} ${text(vars, 'ideaTitle')}.`,
        'Read the thread and reply from the idea page.',
      ],
      cta: { label: 'Open the discussion', url: ideaLink(ctx, vars) },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const waitlistIdeaLive: EmailTemplateDefinition = {
  id: 'WAITLIST_IDEA_LIVE',
  category: 'transactional',
  label: 'Saved idea is live',
  requiredVariables: [],
  optionalVariables: ['ideaTitle', 'ideaId'],
  build(vars, ctx) {
    const title = text(vars, 'ideaTitle');
    return {
      subject: title ? `${title} is now live on Inverge` : 'A saved idea is now live on Inverge',
      previewText: 'The idea you saved opened a campaign.',
      heading: 'An idea you saved is live',
      paragraphs: [
        title
          ? `The idea you saved, ${title}, is now live and accepting support.`
          : 'An idea you saved is now live and accepting support.',
      ],
      cta: { label: 'View the campaign', url: ideaLink(ctx, vars) },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const accountUpdate: EmailTemplateDefinition = {
  id: 'ACCOUNT_UPDATE',
  category: 'transactional',
  label: 'Account update (safe fallback)',
  requiredVariables: [],
  build(_vars, ctx) {
    return {
      subject: 'An update from Inverge',
      previewText: 'There is a new update on your Inverge account.',
      heading: 'There is an update on your account',
      paragraphs: [
        'There is a new update on your Inverge account.',
        'Open Inverge to see the details. Internal template names and event data are never shown in email.',
      ],
      cta: { label: 'Open Inverge', url: appLink(ctx, '/d/notifications') },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const campaignSubmitted: EmailTemplateDefinition = {
  id: 'CAMPAIGN_SUBMITTED',
  category: 'transactional',
  label: 'Campaign submitted for review',
  requiredVariables: ['campaignTitle'],
  build(vars, ctx) {
    return {
      subject: `${text(vars, 'campaignTitle')} is in review`,
      previewText: 'The application fee is confirmed and the campaign is queued.',
      heading: 'Campaign submitted',
      paragraphs: [
        `${text(vars, 'campaignTitle')} has been submitted for curation review. The application fee is confirmed and does not need to be paid again if changes are requested.`,
        'You will be notified when a reviewer approves it or asks for changes.',
      ],
      cta: { label: 'Open campaign workspace', url: campaignCreatorLink(ctx, vars) },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const campaignApproved: EmailTemplateDefinition = {
  id: 'CAMPAIGN_APPROVED',
  category: 'transactional',
  label: 'Campaign approved',
  requiredVariables: ['campaignTitle'],
  build(vars, ctx) {
    return {
      subject: `${text(vars, 'campaignTitle')} is approved`,
      previewText: 'The next step is deploying and publishing the escrow campaign.',
      heading: 'Campaign approved',
      paragraphs: [
        `${text(vars, 'campaignTitle')} passed curation review.`,
        'Approval is not publication: the escrow deployment must be confirmed on-chain before the campaign can go live.',
      ],
      cta: { label: 'Continue to deployment', url: campaignCreatorLink(ctx, vars) },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const campaignChangesRequested: EmailTemplateDefinition = {
  id: 'CAMPAIGN_CHANGES_REQUESTED',
  category: 'transactional',
  label: 'Campaign changes requested',
  requiredVariables: ['campaignTitle'],
  build(vars, ctx) {
    return {
      subject: `Changes requested for ${text(vars, 'campaignTitle')}`,
      previewText: 'A reviewer asked for updates before approval.',
      heading: 'Changes requested',
      paragraphs: [
        `A reviewer asked for changes to ${text(vars, 'campaignTitle')}.`,
        'The review note is in your campaign workspace. Update the draft and resubmit; the application fee is not charged again.',
      ],
      cta: { label: 'Open campaign workspace', url: campaignCreatorLink(ctx, vars) },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const campaignPublished: EmailTemplateDefinition = {
  id: 'CAMPAIGN_PUBLISHED',
  category: 'transactional',
  label: 'Campaign published',
  requiredVariables: ['campaignTitle'],
  build(vars, ctx) {
    return {
      subject: `${text(vars, 'campaignTitle')} is live`,
      previewText: 'The campaign is accepting contributions.',
      heading: 'Your campaign is live',
      paragraphs: [
        `${text(vars, 'campaignTitle')} is published and accepting contributions.`,
        'Funding and escrow outcomes are reported only after the trusted chain event is confirmed.',
      ],
      cta: { label: 'Open campaign workspace', url: campaignCreatorLink(ctx, vars) },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const campaignFunded: EmailTemplateDefinition = {
  id: 'CAMPAIGN_FUNDED',
  category: 'transactional',
  label: 'Campaign reached its target',
  requiredVariables: ['campaignTitle'],
  build(vars, ctx) {
    return {
      subject: `${text(vars, 'campaignTitle')} reached its funding target`,
      previewText: 'Milestone work can begin once the funding event is confirmed.',
      heading: 'Funding target reached',
      paragraphs: [
        `${text(vars, 'campaignTitle')} reached its funding target.`,
        'Milestone work can begin. Tranche releases remain linked to milestone evidence and the objection window.',
      ],
      cta: { label: 'Open campaign workspace', url: campaignCreatorLink(ctx, vars) },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const milestoneReview: EmailTemplateDefinition = {
  id: 'MILESTONE_REVIEW',
  category: 'transactional',
  label: 'Milestone review window',
  requiredVariables: ['milestoneTitle'],
  build(vars, ctx) {
    return {
      subject: `Review window open: ${text(vars, 'milestoneTitle')}`,
      previewText: 'Evidence has been submitted and the objection window is open.',
      heading: 'Milestone review window open',
      paragraphs: [
        `Backers can now review ${text(vars, 'milestoneTitle')}.`,
        'Open the campaign to see the submitted evidence and any objections. Tranche release is decided by the programme rules, not by this notification.',
      ],
      cta: { label: 'Review the milestone', url: campaignCreatorLink(ctx, vars) },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const kycApproved: EmailTemplateDefinition = {
  id: 'KYC_APPROVED',
  category: 'transactional',
  label: 'Identity verification approved',
  requiredVariables: [],
  build(_vars, ctx) {
    return {
      subject: 'Your Inverge identity verification is complete',
      previewText: 'Identity verification no longer blocks your account.',
      heading: 'Identity verification complete',
      paragraphs: [
        'Your identity verification was approved.',
        'This is separate from email ownership and from any payment or escrow eligibility decision. Review your account to see what is available.',
      ],
      cta: { label: 'Review verification status', url: appLink(ctx, '/d/settings') },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const kycDeclined: EmailTemplateDefinition = {
  id: 'KYC_DECLINED',
  category: 'transactional',
  label: 'Identity verification declined',
  requiredVariables: [],
  build(_vars, ctx) {
    return {
      subject: 'Inverge could not verify your identity',
      previewText: 'You can review the next step in your account.',
      heading: 'Identity verification was not approved',
      paragraphs: [
        'The identity check for your Inverge account was not approved.',
        'Open your account to see the next available action. Support cannot change a verification decision in an email reply.',
      ],
      cta: { label: 'Review verification status', url: appLink(ctx, '/d/settings') },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const kycActionRequired: EmailTemplateDefinition = {
  id: 'KYC_ACTION_REQUIRED',
  category: 'transactional',
  label: 'Identity verification needs action',
  requiredVariables: [],
  build(_vars, ctx) {
    return {
      subject: 'Action needed to finish verifying your identity',
      previewText: 'The verification provider needs another step from you.',
      heading: 'More information is needed',
      paragraphs: [
        'Your identity verification is paused until you complete another step with the verification provider.',
        'Open your account to continue. No payment or campaign decision is made by this message.',
      ],
      cta: { label: 'Continue verification', url: appLink(ctx, '/d/settings') },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const amlReview: EmailTemplateDefinition = {
  id: 'AML_REVIEW',
  category: 'transactional',
  label: 'AML screening under review',
  requiredVariables: [],
  build(_vars, ctx) {
    return {
      subject: 'Your Inverge account is under compliance review',
      previewText: 'A screening result needs a human review before it clears.',
      heading: 'Compliance review in progress',
      paragraphs: [
        'A sanctions and anti-money-laundering screening result needs a human review. This is not a rejection.',
        'We will notify you when the review is complete. Do not send identity documents in reply to this email.',
      ],
      cta: { label: 'Review account status', url: appLink(ctx, '/d/settings') },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

const amlClear: EmailTemplateDefinition = {
  id: 'AML_CLEAR',
  category: 'transactional',
  label: 'AML screening cleared',
  requiredVariables: [],
  build(_vars, ctx) {
    return {
      subject: 'Your Inverge compliance check cleared',
      previewText: 'Your account is no longer held for AML review.',
      heading: 'Compliance check cleared',
      paragraphs: [
        'The sanctions and anti-money-laundering screening on your account cleared.',
        'Payment and campaign eligibility are decided separately and may still require identity or business verification.',
      ],
      cta: { label: 'Review account status', url: appLink(ctx, '/d/settings') },
      footerReason: TRANSACTIONAL_REASON,
    };
  },
};

function editorial(
  id: EmailTemplateId,
  label: string,
  subject: (vars: TemplateVariables) => string,
  heading: (vars: TemplateVariables) => string,
  paragraphs: (vars: TemplateVariables) => string[],
  requiredVariables: readonly string[],
  ctaLabel = 'Read on Inverge',
): EmailTemplateDefinition {
  return {
    id,
    category: 'marketing',
    label,
    requiredVariables,
    optionalVariables: ['items', 'ctaUrl', 'ctaLabel'],
    build(vars, ctx) {
      const ctaUrl = text(vars, 'ctaUrl') || appLink(ctx, '/');
      return {
        subject: subject(vars),
        previewText: paragraphs(vars)[0] ?? label,
        heading: heading(vars),
        paragraphs: paragraphs(vars),
        items: itemList(vars, 'items'),
        cta: { label: text(vars, 'ctaLabel') || ctaLabel, url: ctaUrl },
        footerReason: EDITORIAL_REASON,
      };
    },
  };
}

export const EMAIL_TEMPLATES: Record<EmailTemplateId, EmailTemplateDefinition> = {
  VERIFICATION_CODE: verificationCode,
  EMAIL_VERIFIED: verifiedEmail,
  EMAIL_CHANGED: changedEmail,
  IDEA_PUBLISHED: ideaPublished,
  IDEA_FEEDBACK: ideaFeedback,
  IDEA_COMMENT: ideaComment,
  WAITLIST_IDEA_LIVE: waitlistIdeaLive,
  ACCOUNT_UPDATE: accountUpdate,
  CAMPAIGN_SUBMITTED: campaignSubmitted,
  CAMPAIGN_APPROVED: campaignApproved,
  CAMPAIGN_CHANGES_REQUESTED: campaignChangesRequested,
  CAMPAIGN_PUBLISHED: campaignPublished,
  CAMPAIGN_FUNDED: campaignFunded,
  MILESTONE_REVIEW: milestoneReview,
  KYC_APPROVED: kycApproved,
  KYC_DECLINED: kycDeclined,
  KYC_ACTION_REQUIRED: kycActionRequired,
  AML_REVIEW: amlReview,
  AML_CLEAR: amlClear,
  EDIT_INVERGE: editorial(
    'EDIT_INVERGE',
    'The INVERGE Edit',
    (vars) => `The INVERGE Edit: ${text(vars, 'issueTitle')}`,
    (vars) => text(vars, 'issueTitle'),
    (vars) => [text(vars, 'intro')],
    ['issueTitle', 'intro'],
  ),
  IDEA_OF_THE_WEEK: editorial(
    'IDEA_OF_THE_WEEK',
    'Idea of the Week',
    (vars) => `Idea of the Week: ${text(vars, 'ideaTitle')}`,
    () => 'Idea of the Week',
    (vars) => [text(vars, 'ideaSummary')],
    ['ideaTitle', 'ideaSummary'],
    'Read the idea',
  ),
  EDITORS_PICK: editorial(
    'EDITORS_PICK',
    "Editor's Pick",
    (vars) => `Editor's Pick: ${text(vars, 'pickTitle')}`,
    () => "Editor's Pick",
    (vars) => [text(vars, 'pickSummary')],
    ['pickTitle', 'pickSummary'],
  ),
  CREATOR_OF_THE_WEEK: editorial(
    'CREATOR_OF_THE_WEEK',
    'Creator of the Week or Month',
    (vars) => `Creator of the Week: ${text(vars, 'creatorName')}`,
    () => 'Creator of the Week',
    (vars) => [text(vars, 'summary')],
    ['creatorName', 'summary'],
  ),
  UPCOMING_COMPETITIONS: editorial(
    'UPCOMING_COMPETITIONS',
    'Upcoming competitions and ideathons',
    () => 'Upcoming competitions and ideathons',
    () => 'What is open next',
    (vars) => [text(vars, 'intro')],
    ['intro'],
    'See what is open',
  ),
  CAMPAIGN_HIGHLIGHTS: editorial(
    'CAMPAIGN_HIGHLIGHTS',
    'Campaign highlights',
    () => 'Campaign highlights on Inverge',
    () => 'Campaigns worth a look',
    (vars) => [text(vars, 'intro')],
    ['intro'],
    'Browse campaigns',
  ),
  PLATFORM_ANNOUNCEMENT: editorial(
    'PLATFORM_ANNOUNCEMENT',
    'Platform announcement',
    (vars) => text(vars, 'title'),
    (vars) => text(vars, 'title'),
    (vars) => [text(vars, 'summary')],
    ['title', 'summary'],
    'Open Inverge',
  ),
};

export const EMAIL_TEMPLATE_IDS = Object.keys(EMAIL_TEMPLATES) as EmailTemplateId[];

export function isEmailTemplateId(value: string): value is EmailTemplateId {
  return Object.prototype.hasOwnProperty.call(EMAIL_TEMPLATES, value);
}

/** Catalogue metadata for admin tooling; contains no secrets or recipient data. */
export function emailTemplateCatalogue() {
  return EMAIL_TEMPLATE_IDS.map((id) => {
    const definition = EMAIL_TEMPLATES[id];
    return {
      id,
      category: definition.category,
      label: definition.label,
      requiredVariables: [...definition.requiredVariables],
      optionalVariables: [...(definition.optionalVariables ?? [])],
    };
  });
}
