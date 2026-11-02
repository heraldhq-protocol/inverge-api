import { renderNotificationEmail } from './notification-email';

describe('renderNotificationEmail', () => {
  it('renders a named idea and escapes user-controlled text', () => {
    const content = renderNotificationEmail({
      toUserId: 'u1',
      template: 'WAITLIST_CONVERSION',
      data: { ideaTitle: '<script>alert(1)</script>' },
    });

    expect(content.subject).not.toContain('<script>');
    expect(content.html).not.toContain('<script>');
    expect(content.html).toContain('&lt;script&gt;');
  });

  it('uses campaign copy for a funded campaign', () => {
    const content = renderNotificationEmail({
      toUserId: 'u1',
      template: 'CAMPAIGN_FUNDED',
      data: { campaignTitle: 'Solar cold chain' },
    });

    expect(content.subject).toContain('Solar cold chain');
    expect(content.text).toContain('funding target');
  });

  it('falls back to safe generic copy for an unknown template', () => {
    const content = renderNotificationEmail({
      toUserId: 'u1',
      template: 'INTERNAL_ONLY_EVENT',
      data: { secret: 'do-not-render' },
    });

    expect(content.subject).toBe('An update from Inverge');
    expect(content.text).not.toContain('INTERNAL_ONLY_EVENT');
    expect(content.text).not.toContain('do-not-render');
  });
});
