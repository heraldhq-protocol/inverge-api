import { createUnsubscribeToken, renderEmailTemplate, verifyUnsubscribeToken } from './index';
import { EMAIL_BRAND } from './brand';

const context = {
  appUrl: 'https://inverge.test',
  preferencesUrl: 'https://inverge.test/d/settings',
  unsubscribeUrl: 'https://api.inverge.test/api/v1/email/preferences/token',
  companyAddress: 'Inverge, 1 Test Street, Lagos',
  supportEmail: 'support@inverge.test',
};

describe('renderEmailTemplate', () => {
  it('renders the branded shell with a preheader, mobile rules and both parts', () => {
    const rendered = renderEmailTemplate(
      'IDEA_PUBLISHED',
      { ideaId: 'idea/1', ideaTitle: 'Solar cold chain' },
      context,
    );

    expect(rendered.subject).toContain('Solar cold chain');
    expect(rendered.html).toContain(EMAIL_BRAND.paper);
    expect(rendered.html).toContain(EMAIL_BRAND.emerald);
    expect(rendered.html).toContain(EMAIL_BRAND.forest);
    expect(rendered.html).toContain(EMAIL_BRAND.warmGrey);
    expect(rendered.html).toContain('@media only screen and (max-width:620px)');
    expect(rendered.html).toContain('iv-container');
    expect(rendered.html).toContain('display:none');
    expect(rendered.text).toContain('Solar cold chain');
    expect(rendered.text).not.toContain('<');
  });

  it('escapes user content in the subject and body', () => {
    const rendered = renderEmailTemplate(
      'IDEA_PUBLISHED',
      { ideaTitle: '<script>alert(1)</script>\r\nBcc: evil@example.test' },
      context,
    );

    expect(rendered.subject).not.toContain('<script>');
    expect(rendered.subject).not.toContain('\n');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('rejects missing variables by name without echoing values', () => {
    expect(() => renderEmailTemplate('IDEA_PUBLISHED', {}, context)).toThrow(
      /IDEA_PUBLISHED.*ideaTitle/,
    );
  });

  it('rejects an invalid verification code and purpose', () => {
    expect(() =>
      renderEmailTemplate(
        'VERIFICATION_CODE',
        { code: 'abc', expiresInMinutes: 10, purpose: 'OTHER' },
        context,
      ),
    ).toThrow(/code, purpose/);
  });

  it('renders a one-time code in both parts without an address', () => {
    const rendered = renderEmailTemplate(
      'VERIFICATION_CODE',
      { code: '042817', expiresInMinutes: 10, purpose: 'SIGNUP' },
      context,
    );

    expect(rendered.html).toContain('042817');
    expect(rendered.text).toContain('042817');
    expect(rendered.subject).toBe('Your Inverge verification code');
  });

  it('renders the converted-idea campaign email with a safe CTA and no fabricated figures', () => {
    const rendered = renderEmailTemplate(
      'IDEA_CONVERTED_TO_CAMPAIGN',
      {
        campaignId: 'cmp 1',
        campaignSummary: 'A shared solar cold room for smallholder farmers.',
        campaignTitle: 'Solar cold storage',
        firstName: 'Amara',
        ideaTitle: 'Solar cold storage',
      },
      context,
    );

    expect(rendered.subject).toBe('An idea you supported is now a campaign');
    expect(rendered.html).toContain('Hi Amara');
    expect(rendered.html).toContain('https://inverge.test/campaigns/cmp%201');
    expect(rendered.html).toContain('did not charge you');
    expect(rendered.text).toContain('did not charge you');
    expect(rendered.text).not.toContain('Funding goal');
    expect(rendered.text).not.toContain('Funding deadline');
  });

  it('renders optional campaign figures and a cover only when provided', () => {
    const rendered = renderEmailTemplate(
      'IDEA_CONVERTED_TO_CAMPAIGN',
      {
        campaignId: 'cmp1',
        campaignTitle: 'Solar cold storage',
        coverImageUrl: '/images/solar.jpg',
        fundingDeadline: '1 December 2026',
        fundingGoal: '$5,000.00',
      },
      context,
    );

    expect(rendered.html).toContain('$5,000.00');
    expect(rendered.html).toContain('1 December 2026');
    expect(rendered.html).toContain('https://inverge.test/images/solar.jpg');
    expect(rendered.html).toContain('Hi there');
  });

  it('drops an invalid campaign cover instead of rendering a broken image', () => {
    const rendered = renderEmailTemplate(
      'IDEA_CONVERTED_TO_CAMPAIGN',
      {
        campaignId: 'cmp1',
        campaignTitle: 'Solar cold storage',
        coverImageUrl: 'javascript:alert(1)',
      },
      context,
    );

    expect(rendered.html).not.toContain('javascript:');
    expect(rendered.html).not.toContain('<img src="javascript');
  });

  it('refuses marketing mail without an unsubscribe link or sender address', () => {
    expect(() =>
      renderEmailTemplate(
        'IDEA_OF_THE_WEEK',
        { ideaTitle: 'X', ideaSummary: 'Y' },
        { appUrl: context.appUrl },
      ),
    ).toThrow(/unsubscribeUrl, companyAddress/);
  });

  it('renders an editorial issue with an unsubscribe link and postal address', () => {
    const rendered = renderEmailTemplate(
      'EDIT_INVERGE',
      {
        issueTitle: 'The INVERGE Edit #1',
        intro: 'Ideas worth backing this week.',
        items: [{ title: 'AgroRoute', summary: 'Cold storage', url: 'https://inverge.test/ideas/1' }],
      },
      context,
    );

    expect(rendered.subject).toContain('The INVERGE Edit #1');
    expect(rendered.html).toContain('Unsubscribe');
    expect(rendered.text).toContain('Unsubscribe: https://api.inverge.test');
    expect(rendered.html).toContain('1 Test Street');
  });

  it('drops a non-http CTA instead of rendering it', () => {
    const rendered = renderEmailTemplate(
      'IDEA_OF_THE_WEEK',
      {
        ideaTitle: 'X',
        ideaSummary: 'Y',
        ctaUrl: 'javascript:alert(1)',
      },
      context,
    );

    expect(rendered.html).not.toContain('javascript:');
    expect(rendered.html).not.toContain('Read the idea');
  });

  it('always includes a footer reason', () => {
    const rendered = renderEmailTemplate('EMAIL_VERIFIED', {}, context);
    expect(rendered.html).toContain('You received this because');
    expect(rendered.text).toContain('You received this because');
  });

  it('keeps preference and unsubscribe paths instead of truncating them to the origin', () => {
    const rendered = renderEmailTemplate('IDEA_CONVERTED_TO_CAMPAIGN', {
      campaignId: 'cmp1',
      campaignTitle: 'Solar cold storage',
    }, context);

    expect(rendered.html).toContain('https://inverge.test/d/settings');
    expect(rendered.text).toContain('https://inverge.test/d/settings');
    expect(rendered.html).toContain('https://inverge.test/privacy');
    expect(rendered.text).toContain('Privacy: https://inverge.test/privacy');
  });
});

describe('unsubscribe tokens', () => {
  const secret = 'unsubscribe-secret-at-least-32-characters';

  it('round-trips the subscription id', () => {
    const token = createUnsubscribeToken(secret, 'sub_12345678');
    expect(verifyUnsubscribeToken(secret, token)).toBe('sub_12345678');
  });

  it('rejects a forged signature and a rotated secret', () => {
    const token = createUnsubscribeToken(secret, 'sub_12345678');
    expect(verifyUnsubscribeToken(secret, `${token}tampered`)).toBeNull();
    expect(verifyUnsubscribeToken(`${secret}-rotated`, token)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyUnsubscribeToken(secret, '')).toBeNull();
    expect(verifyUnsubscribeToken(secret, 'short.x')).toBeNull();
    expect(verifyUnsubscribeToken(secret, 'sub_12345678.')).toBeNull();
  });
});
