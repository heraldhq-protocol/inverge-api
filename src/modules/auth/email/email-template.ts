import type { EmailVerificationPurpose } from '../../../generated/prisma/client';

export interface VerificationEmailContent {
  subject: string;
  text: string;
  html: string;
}

/**
 * Pure renderer for the verification email. It takes only a six-digit code and
 * static copy, so no user-controlled string can enter the HTML.
 */
export function renderVerificationEmail(input: {
  code: string;
  expiresInMinutes: number;
  purpose: EmailVerificationPurpose;
}): VerificationEmailContent {
  const { code, expiresInMinutes, purpose } = input;
  const changing = purpose === 'CHANGE';
  const subject = changing
    ? 'Confirm your new Inverge email address'
    : 'Your Inverge verification code';
  const intro = changing
    ? 'Use this code to confirm the new email address for your Inverge account.'
    : 'Use this code to confirm your email address and finish setting up your Inverge account.';
  const ignore = changing
    ? 'If you did not ask to change your email, ignore this message. Your current address stays in place until this code is entered.'
    : 'If you did not create an Inverge account, ignore this message. Nothing changes until the code is entered.';

  const text = [
    'INVERGE',
    '',
    intro,
    '',
    `Verification code: ${code}`,
    '',
    `This code expires in ${expiresInMinutes} minutes and can be used once.`,
    '',
    ignore,
    '',
    'Inverge will never ask you for this code by phone or social media.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${subject}</title>
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
              <td style="padding:32px 28px 8px;">
                <h1 style="margin:0;color:#0D1D15;font-size:24px;line-height:1.25;">${changing ? 'Confirm your new email' : 'Confirm your email'}</h1>
                <p style="margin:12px 0 0;color:#4B4B48;font-size:15px;line-height:1.6;">${intro}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px;">
                <div style="background:#F3FAF6;border:1px solid #CFE9D9;border-radius:12px;padding:20px;text-align:center;">
                  <p style="margin:0 0 6px;color:#116B3A;font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">Verification code</p>
                  <p style="margin:0;color:#0D1D15;font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:700;letter-spacing:0.28em;">${code}</p>
                </div>
                <p style="margin:16px 0 0;color:#71716E;font-size:13px;line-height:1.6;">This code expires in ${expiresInMinutes} minutes and can be used once.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 28px;">
                <p style="margin:0;color:#4B4B48;font-size:13px;line-height:1.6;">${ignore}</p>
                <p style="margin:12px 0 0;color:#71716E;font-size:12px;line-height:1.6;">Inverge will never ask you for this code by phone or social media.</p>
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
