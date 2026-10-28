import { verifiedGoogleAvatarUrl } from './google-avatar';

describe('verifiedGoogleAvatarUrl', () => {
  it('accepts an HTTPS Google profile image', () => {
    expect(
      verifiedGoogleAvatarUrl(
        'https://lh3.googleusercontent.com/a/ACg8oc-example=s96-c',
      ),
    ).toBe('https://lh3.googleusercontent.com/a/ACg8oc-example=s96-c');
  });

  it('accepts each Google image host', () => {
    for (const host of [
      'lh3.googleusercontent.com',
      'lh4.googleusercontent.com',
      'lh5.googleusercontent.com',
      'lh6.googleusercontent.com',
    ]) {
      expect(verifiedGoogleAvatarUrl(`https://${host}/a/example`)).toBe(
        `https://${host}/a/example`,
      );
    }
  });

  it('rejects a non-Google host', () => {
    expect(verifiedGoogleAvatarUrl('https://evil.test/avatar.png')).toBeUndefined();
  });

  it('rejects a non-HTTPS URL', () => {
    expect(
      verifiedGoogleAvatarUrl('http://lh3.googleusercontent.com/a/example'),
    ).toBeUndefined();
  });

  it('rejects credentials, javascript and malformed values', () => {
    expect(
      verifiedGoogleAvatarUrl(
        'https://user:pass@lh3.googleusercontent.com/a/example',
      ),
    ).toBeUndefined();
    expect(verifiedGoogleAvatarUrl('javascript:alert(1)')).toBeUndefined();
    expect(verifiedGoogleAvatarUrl('not a url')).toBeUndefined();
    expect(verifiedGoogleAvatarUrl(123)).toBeUndefined();
    expect(verifiedGoogleAvatarUrl('')).toBeUndefined();
  });

  it('rejects an overlong URL', () => {
    expect(
      verifiedGoogleAvatarUrl(
        `https://lh3.googleusercontent.com/a/${'x'.repeat(2048)}`,
      ),
    ).toBeUndefined();
  });
});
