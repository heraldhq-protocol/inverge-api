import { notificationEmailTemplate } from './notification-email';

function message(template: string, data: Record<string, unknown> = {}) {
  return { toUserId: 'u1', template, data };
}

describe('notificationEmailTemplate', () => {
  it('maps a waitlist conversion and keeps only declared variables', () => {
    const mapping = notificationEmailTemplate(
      message('WAITLIST_CONVERSION', {
        ideaTitle: 'Solar cold chain',
        ideaId: 'i1',
        secret: 'do-not-render',
      }),
    );

    expect(mapping.templateId).toBe('WAITLIST_IDEA_LIVE');
    expect(mapping.variables).toEqual({
      ideaId: 'i1',
      ideaTitle: 'Solar cold chain',
    });
  });

  it('maps a pre-pledge campaign conversion and drops unknown data', () => {
    const mapping = notificationEmailTemplate(
      message('IDEA_CONVERTED_TO_CAMPAIGN', {
        campaignId: 'c1',
        campaignTitle: 'Solar cold chain',
        firstName: 'Amara',
        fundingGoal: '$5,000.00',
        ideaTitle: 'Cold chain',
        secret: 'do-not-render',
      }),
    );

    expect(mapping.templateId).toBe('IDEA_CONVERTED_TO_CAMPAIGN');
    expect(mapping.variables).toEqual({
      campaignId: 'c1',
      campaignTitle: 'Solar cold chain',
      firstName: 'Amara',
      fundingGoal: '$5,000.00',
      ideaTitle: 'Cold chain',
    });
  });

  it('maps milestone aliases to one template', () => {
    expect(
      notificationEmailTemplate(message('MILESTONE_OBJECTION_WINDOW', { milestoneTitle: 'M1' }))
        .templateId,
    ).toBe('MILESTONE_REVIEW');
    expect(
      notificationEmailTemplate(message('MILESTONE_REVIEW', { milestoneTitle: 'M1' }))
        .templateId,
    ).toBe('MILESTONE_REVIEW');
  });

  it('falls back to safe generic copy for an unknown template', () => {
    const mapping = notificationEmailTemplate(
      message('INTERNAL_ONLY_EVENT', { secret: 'do-not-render' }),
    );

    expect(mapping).toEqual({ templateId: 'ACCOUNT_UPDATE', variables: {} });
  });

  it('drops non-string data instead of coercing it into copy', () => {
    const mapping = notificationEmailTemplate(
      message('IDEA_PUBLISHED', { ideaTitle: { nested: 'x' }, ideaId: 42 }),
    );

    expect(mapping.variables).toEqual({});
  });
});
