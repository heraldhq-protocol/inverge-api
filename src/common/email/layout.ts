import {
  EMAIL_BRAND,
  EmailLocale,
  escapeHtml,
  headerText,
  safeEmailUrl,
} from './brand';

export type EmailCategory = 'transactional' | 'marketing';

export interface EmailDetail {
  label: string;
  value: string;
}

export interface EmailItem {
  title: string;
  summary?: string;
  meta?: string;
  url?: string;
}

/** Copy and structure a template produces before it is escaped into HTML. */
export interface EmailContent {
  subject: string;
  previewText: string;
  heading: string;
  paragraphs: string[];
  /** Optional hero image. Rendered only when the URL is an absolute http(s) URL. */
  image?: { alt: string; url: string };
  details?: EmailDetail[];
  items?: EmailItem[];
  /** A one-time code panel (verification mail). Rendered monospace. */
  code?: { label: string; value: string; hint?: string };
  cta?: { label: string; url: string };
  note?: string;
  footerReason: string;
}

export interface EmailRenderContext {
  /** Web app origin, e.g. https://inverge.xyz. Never a provider endpoint. */
  appUrl: string;
  locale: EmailLocale;
  /** Absolute, hosted logo URL. Omitted when the deployment has no asset host. */
  logoUrl?: string | null;
  supportEmail?: string | null;
  /** Required for marketing mail (CAN-SPAM sender identification). */
  companyAddress?: string | null;
  preferencesUrl?: string | null;
  unsubscribeUrl?: string | null;
}

export interface RenderedEmail {
  subject: string;
  previewText: string;
  html: string;
  text: string;
}

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function paragraphsHtml(paragraphs: string[]): string {
  return paragraphs
    .filter((paragraph) => paragraph.trim().length > 0)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;color:${EMAIL_BRAND.inkSoft};font-size:16px;line-height:1.65;">${escapeHtml(
          paragraph,
        )}</p>`,
    )
    .join('');
}

function detailsHtml(details: EmailDetail[] | undefined): string {
  if (!details || details.length === 0) return '';
  const rows = details
    .map(
      (detail) => `<tr>
        <td style="padding:10px 0;border-bottom:1px solid ${EMAIL_BRAND.warmGrey};color:${EMAIL_BRAND.muted};font-size:13px;line-height:1.5;vertical-align:top;width:42%;">${escapeHtml(
          detail.label,
        )}</td>
        <td style="padding:10px 0;border-bottom:1px solid ${EMAIL_BRAND.warmGrey};color:${EMAIL_BRAND.forest};font-size:14px;font-weight:600;line-height:1.5;text-align:right;">${escapeHtml(
          detail.value,
        )}</td>
      </tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-top:1px solid ${EMAIL_BRAND.warmGrey};">${rows}</table>`;
}

function itemsHtml(items: EmailItem[] | undefined): string {
  if (!items || items.length === 0) return '';
  return items
    .map((item) => {
      const url = safeEmailUrl(item.url);
      const title = url
        ? `<a href="${escapeHtml(url)}" style="color:${EMAIL_BRAND.forest};font-size:17px;font-weight:700;line-height:1.4;text-decoration:underline;">${escapeHtml(
            item.title,
          )}</a>`
        : `<span style="color:${EMAIL_BRAND.forest};font-size:17px;font-weight:700;line-height:1.4;">${escapeHtml(
            item.title,
          )}</span>`;
      const summary = item.summary
        ? `<p style="margin:6px 0 0;color:${EMAIL_BRAND.inkSoft};font-size:15px;line-height:1.6;">${escapeHtml(
            item.summary,
          )}</p>`
        : '';
      const meta = item.meta
        ? `<p style="margin:6px 0 0;color:${EMAIL_BRAND.muted};font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(
            item.meta,
          )}</p>`
        : '';
      return `<div style="margin:0 0 22px;padding:0 0 22px;border-bottom:1px solid ${EMAIL_BRAND.warmGrey};">${meta}${title}${summary}</div>`;
    })
    .join('');
}

function codeHtml(code: EmailContent['code']): string {
  if (!code) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
    <tr>
      <td style="background:${EMAIL_BRAND.brandTint};border:1px solid ${EMAIL_BRAND.borderSoft};border-radius:12px;padding:20px;text-align:center;">
        <p style="margin:0 0 6px;color:${EMAIL_BRAND.brandStrong};font-family:${FONT_STACK};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">${escapeHtml(
          code.label,
        )}</p>
        <p class="iv-code" style="margin:0;color:${EMAIL_BRAND.forest};font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:700;letter-spacing:0.28em;">${escapeHtml(
          code.value,
        )}</p>
        ${
          code.hint
            ? `<p style="margin:10px 0 0;color:${EMAIL_BRAND.muted};font-size:13px;line-height:1.6;">${escapeHtml(
                code.hint,
              )}</p>`
            : ''
        }
      </td>
    </tr>
  </table>`;
}

/**
 * A table-based button. Outlook ignores `border-radius`, so the anchor also
 * carries its own background and padding and degrades to a rectangle there.
 */
function ctaHtml(cta: EmailContent['cta']): string {
  const url = safeEmailUrl(cta?.url);
  if (!cta || !url) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
    <tr>
      <td align="center" bgcolor="${EMAIL_BRAND.emerald}" style="border-radius:10px;mso-padding-alt:14px 26px;">
        <a href="${escapeHtml(
          url,
        )}" style="display:inline-block;padding:14px 26px;color:#FFFFFF;font-family:${FONT_STACK};font-size:15px;font-weight:700;line-height:1.2;text-decoration:none;border-radius:10px;">${escapeHtml(
          cta.label,
        )}</a>
      </td>
    </tr>
  </table>`;
}

function footerHtml(
  content: EmailContent,
  ctx: EmailRenderContext,
  category: EmailCategory,
): string {
  const links: string[] = [];
  const preferencesUrl = safeEmailUrl(ctx.preferencesUrl);
  const unsubscribeUrl = safeEmailUrl(ctx.unsubscribeUrl);
  if (preferencesUrl) {
    links.push(
      `<a href="${escapeHtml(
        preferencesUrl,
      )}" style="color:${EMAIL_BRAND.brandStrong};font-size:12px;line-height:1.8;text-decoration:underline;">Manage email preferences</a>`,
    );
  }
  if (category === 'marketing' && unsubscribeUrl) {
    links.push(
      `<a href="${escapeHtml(
        unsubscribeUrl,
      )}" style="color:${EMAIL_BRAND.brandStrong};font-size:12px;line-height:1.8;text-decoration:underline;">Unsubscribe</a>`,
    );
  }
  if (ctx.supportEmail) {
    links.push(
      `<a href="mailto:${escapeHtml(
        ctx.supportEmail,
      )}" style="color:${EMAIL_BRAND.brandStrong};font-size:12px;line-height:1.8;text-decoration:underline;">Contact support</a>`,
    );
  }
  const address = ctx.companyAddress?.trim()
    ? `<p style="margin:8px 0 0;color:${EMAIL_BRAND.muted};font-size:11px;line-height:1.6;">${escapeHtml(
        ctx.companyAddress.trim(),
      )}</p>`
    : '';
  return `<tr>
    <td class="iv-pad" style="padding:24px 32px 32px;background:${EMAIL_BRAND.surfaceMuted};border-top:1px solid ${EMAIL_BRAND.warmGrey};">
      <p style="margin:0 0 6px;color:${EMAIL_BRAND.forest};font-size:14px;font-weight:700;line-height:1.4;">Inverge</p>
      <p style="margin:0 0 10px;color:${EMAIL_BRAND.muted};font-size:12px;line-height:1.6;">${escapeHtml(
        content.footerReason,
      )}</p>
      <p style="margin:0;color:${EMAIL_BRAND.muted};font-size:12px;line-height:1.8;">${links.join(
        ' &nbsp;&middot;&nbsp; ',
      )}</p>
      ${address}
      <p style="margin:10px 0 0;color:${EMAIL_BRAND.muted};font-size:11px;line-height:1.6;">Sent by Inverge, milestone-escrowed crowdfunding and idea validation.</p>
    </td>
  </tr>`;
}

export function renderEmailHtml(
  content: EmailContent,
  ctx: EmailRenderContext,
  category: EmailCategory,
): string {
  const subject = headerText(content.subject);
  const previewText = headerText(content.previewText, 240);
  const logoUrl = safeEmailUrl(ctx.logoUrl);
  const logo = logoUrl
    ? `<img src="${escapeHtml(
        logoUrl,
      )}" width="32" height="32" alt="" aria-hidden="true" style="display:inline-block;width:32px;height:32px;border:0;outline:none;text-decoration:none;vertical-align:middle;margin-right:10px;" />`
    : '';

  return `<!doctype html>
<html lang="${ctx.locale}" dir="ltr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${escapeHtml(subject)}</title>
    <style>
      html,body{margin:0!important;padding:0!important;width:100%!important;}
      body{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;background:${EMAIL_BRAND.paper};}
      table{border-collapse:collapse!important;mso-table-lspace:0;mso-table-rspace:0;}
      img{-ms-interpolation-mode:bicubic;border:0;height:auto;line-height:100%;outline:none;text-decoration:none;}
      a{color:${EMAIL_BRAND.brandStrong};}
      @media only screen and (max-width:620px){
        .iv-container{width:100%!important;max-width:100%!important;border-radius:0!important;border-left:0!important;border-right:0!important;}
        .iv-pad{padding-left:20px!important;padding-right:20px!important;}
        .iv-heading{font-size:23px!important;line-height:1.25!important;}
        .iv-code{font-size:30px!important;letter-spacing:0.22em!important;}
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${EMAIL_BRAND.paper};color:${EMAIL_BRAND.ink};">
    <div style="display:none;font-size:1px;color:${EMAIL_BRAND.paper};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(
      previewText,
    )}${'&#8199;&#65279;'.repeat(20)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_BRAND.paper};">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <table role="presentation" class="iv-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${EMAIL_BRAND.surface};border:1px solid ${EMAIL_BRAND.warmGrey};border-radius:16px;overflow:hidden;">
            <tr>
              <td style="background:${EMAIL_BRAND.forest};padding:20px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="vertical-align:middle;">${logo}</td>
                    <td style="vertical-align:middle;">
                      <span style="color:#FFFFFF;font-family:${FONT_STACK};font-size:15px;font-weight:700;letter-spacing:0.18em;">INVERGE</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="height:4px;background:${EMAIL_BRAND.emerald};font-size:0;line-height:0;">&nbsp;</td>
            </tr>
            <tr>
              <td class="iv-pad" style="padding:32px 32px 8px;">
                <h1 class="iv-heading" style="margin:0;color:${EMAIL_BRAND.forest};font-family:${FONT_STACK};font-size:26px;line-height:1.28;font-weight:700;">${escapeHtml(
                  content.heading,
                )}</h1>
              </td>
            </tr>
            <tr>
              <td class="iv-pad" style="padding:16px 32px 0;">
                ${paragraphsHtml(content.paragraphs)}
                ${codeHtml(content.code)}
                ${detailsHtml(content.details)}
                ${itemsHtml(content.items)}
                ${ctaHtml(content.cta)}
                ${
                  content.note
                    ? `<p style="margin:0 0 24px;color:${EMAIL_BRAND.muted};font-size:13px;line-height:1.65;">${escapeHtml(
                        content.note,
                      )}</p>`
                    : ''
                }
              </td>
            </tr>
            ${footerHtml(content, ctx, category)}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderEmailText(
  content: EmailContent,
  ctx: EmailRenderContext,
  category: EmailCategory,
): string {
  const lines: string[] = ['INVERGE', '', content.heading, ''];
  for (const paragraph of content.paragraphs) {
    if (paragraph.trim()) lines.push(paragraph, '');
  }
  if (content.code) {
    lines.push(`${content.code.label}: ${content.code.value}`);
    if (content.code.hint) lines.push(content.code.hint);
    lines.push('');
  }
  for (const detail of content.details ?? []) {
    lines.push(`${detail.label}: ${detail.value}`);
  }
  if (content.details?.length) lines.push('');
  for (const item of content.items ?? []) {
    lines.push(item.meta ? `${item.meta}` : '', item.title);
    if (item.summary) lines.push(item.summary);
    const url = safeEmailUrl(item.url);
    if (url) lines.push(url);
    lines.push('');
  }
  const ctaUrl = safeEmailUrl(content.cta?.url);
  if (content.cta && ctaUrl) {
    lines.push(`${content.cta.label}: ${ctaUrl}`, '');
  }
  if (content.note) lines.push(content.note, '');

  lines.push('---', content.footerReason);
  const preferencesUrl = safeEmailUrl(ctx.preferencesUrl);
  if (preferencesUrl) lines.push(`Manage email preferences: ${preferencesUrl}`);
  if (category === 'marketing') {
    const unsubscribeUrl = safeEmailUrl(ctx.unsubscribeUrl);
    if (unsubscribeUrl) lines.push(`Unsubscribe: ${unsubscribeUrl}`);
  }
  if (ctx.supportEmail) lines.push(`Contact support: ${ctx.supportEmail}`);
  if (ctx.companyAddress?.trim()) lines.push(ctx.companyAddress.trim());
  lines.push('Sent by Inverge, milestone-escrowed crowdfunding and idea validation.');

  return lines.join('\n');
}
