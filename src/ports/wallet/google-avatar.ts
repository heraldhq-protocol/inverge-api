/**
 * The profile-image claim in a Google identity token.
 *
 * Google serves these from `lh3`-`lh6.googleusercontent.com`; the exact host is
 * not part of the API contract, so all four are accepted. The URL is stored as
 * an external reference, not downloaded: image uploads and storage are a
 * separate feature. Anything outside this allowlist is dropped rather than
 * stored, so a provider or attacker cannot turn the avatar field into an
 * arbitrary remote URL.
 */
const GOOGLE_AVATAR_HOSTS = new Set([
  'lh3.googleusercontent.com',
  'lh4.googleusercontent.com',
  'lh5.googleusercontent.com',
  'lh6.googleusercontent.com',
]);

/** A browser-safe upper bound; real Google avatar URLs are far shorter. */
const MAX_AVATAR_URL_LENGTH = 2048;

export function verifiedGoogleAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  const raw = value.trim();
  if (!raw || raw.length > MAX_AVATAR_URL_LENGTH) return undefined;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'https:') return undefined;
  if (!GOOGLE_AVATAR_HOSTS.has(url.hostname)) return undefined;
  if (url.username || url.password) return undefined;

  return url.toString();
}

export { GOOGLE_AVATAR_HOSTS };
