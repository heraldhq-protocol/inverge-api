import type { NotificationMessage } from './notification.port';

export interface NotificationEmail {
  subject: string;
  text: string;
  html: string;
}

const BRAND = 'Inverge';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

/** Subjects are headers, not markup: keep text, drop control/angle characters. */
function subjectText(value: string): string {
  return value
    .replace(/[<>\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Render one persisted notification as an email.
 *
 * Only known templates get specific copy. Anything else falls back to a safe
 * generic message: the template name and data are internal identifiers and must
 * never be shown to a recipient.
 */
export function renderNotificationEmail(
  message: NotificationMessage,
): NotificationEmail {
  const data = message.data;
  const ideaTitle = asString(data.ideaTitle);
  const campaignTitle = asString(data.campaignTitle);
  const milestoneTitle = asString(data.milestoneTitle);

  let subject: string;
  let intro: string;

  switch (message.template) {
    case 'WAITLIST_CONVERSION':
      subject = ideaTitle
        ? subjectText(`${ideaTitle} is now live on ${BRAND}`)
        : `Your saved idea is now live on ${BRAND}`;
      intro = ideaTitle
        ? `The idea you saved, ${ideaTitle}, is now live and accepting support.`
        : 'An idea you saved is now live and accepting support.';
      break;
    case 'CAMPAIGN_FUNDED':
      subject = campaignTitle
        ? subjectText(`${campaignTitle} reached its funding target`)
        : `Your campaign reached its funding target`;
      intro = campaignTitle
        ? `${campaignTitle} reached its funding target. Milestone work can begin.`
        : 'Your campaign reached its funding target. Milestone work can begin.';
      break;
    case 'MILESTONE_REVIEW':
    case 'MILESTONE_OBJECTION_WINDOW':
      subject = milestoneTitle
        ? subjectText(`Review window open: ${milestoneTitle}`)
        : 'A milestone review window is open';
      intro = milestoneTitle
        ? `Backers can now review ${milestoneTitle}. Open your campaign to see the evidence and objections.`
        : 'Backers can now review a milestone. Open your campaign to see the evidence and objections.';
      break;
    default:
      subject = `An update from ${BRAND}`;
      intro = `There is a new update on your ${BRAND} account.`;
  }

  const text = [
    BRAND,
    '',
    intro,
    '',
    'Open your Inverge account to see the details.',
    '',
    'You can change which emails you receive in Settings.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#FBF9F5;color:#1F1F1E;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF9F5;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #EAE6E1;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="background:#0D1D15;padding:20px 28px;">
                <p style="margin:0;color:#FFFFFF;font-size:13px;font-weight:700;letter-spacing:0.18em;">INVERGE</p>
              </td>
            </tr>
            <tr>
              <td style="height:4px;background:#1FA85C;font-size:0;line-height:0;">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding:32px 28px;">
                <h1 style="margin:0;color:#0D1D15;font-size:22px;line-height:1.3;">${escapeHtml(subject)}</h1>
                <p style="margin:12px 0 0;color:#4B4B48;font-size:15px;line-height:1.6;">${escapeHtml(intro)}</p>
                <p style="margin:24px 0 0;color:#4B4B48;font-size:14px;line-height:1.6;">Open your Inverge account to see the details.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 28px;">
                <p style="margin:0;color:#71716E;font-size:12px;line-height:1.6;">You can change which emails you receive in Settings.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}
