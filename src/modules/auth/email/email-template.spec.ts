import { renderVerificationEmail } from './email-template';

describe('renderVerificationEmail', () => {
  it('renders the branded shell with the code in both parts', () => {
    // #given a signup code
    const content = renderVerificationEmail({
      code: '042817',
      expiresInMinutes: 10,
      purpose: 'SIGNUP',
    });

    // #then the code and brand colours are present without any user input
    expect(content.subject).toBe('Your Inverge verification code');
    expect(content.text).toContain('042817');
    expect(content.html).toContain('042817');
    expect(content.html).toContain('#1FA85C');
    expect(content.html).toContain('#0D1D15');
    expect(content.html).toContain('10 minutes');
    expect(content.text).toContain('ignore this message');
  });

  it('uses change-specific copy that leaves the current address in place', () => {
    // #given a change code
    const content = renderVerificationEmail({
      code: '123456',
      expiresInMinutes: 10,
      purpose: 'CHANGE',
    });

    // #then the copy explains the old address survives until confirmation
    expect(content.subject).toBe('Confirm your new Inverge email address');
    expect(content.text).toContain('current address stays in place');
    expect(content.html).toContain('current address stays in place');
  });

  it('does not interpolate an address into the message', () => {
    // #given a renderer that takes only the code and static copy
    const content = renderVerificationEmail({
      code: '123456',
      expiresInMinutes: 10,
      purpose: 'SIGNUP',
    });

    // #then the destination is only in the envelope, never the body
    expect(content.text).not.toContain('@');
    expect(content.html).not.toContain('@');
  });
});
