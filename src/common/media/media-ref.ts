import { assetIdFromMediaPath } from './media-key';

/**
 * What a stored media `src` may be.
 *
 * Three concepts stay distinct, exactly as the product requires:
 *
 * - **an uploaded asset**, referenced as `/api/media/<id>` - INVERGE holds the
 *   bytes and decides who may read them;
 * - **an external reference**, an `https` URL to an image hosted elsewhere - the
 *   browser loads it from that host, and INVERGE only vouches for the shape;
 * - **a resolved preview**, never stored here (see the YouTube resolver).
 *
 * Anything else - a `javascript:` URL, a protocol-relative path, a `data:` blob,
 * a credentialed URL, a bare hostname - is not media and is refused.
 *
 * Pure, so both the API and its unit tests share one definition.
 */

export type MediaReference =
  | { kind: 'asset'; id: string }
  | { kind: 'external'; url: string };

/** Matches the `@MaxLength(2048)` on every media field in the DTOs. */
export const MAX_MEDIA_URL_LENGTH = 2048;

/** Hosts that resolve to the machine serving the request, not a public image. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

/**
 * A public `https` image or video URL.
 *
 * This is a *shape* check, not a fetch: no request is ever made to the submitted
 * host, so there is no server-side request forgery surface here. A URL that
 * passes and later 404s degrades in the browser, which is the correct failure
 * mode for a creator's own host.
 */
export function isAcceptableExternalMediaUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;

  const raw = value.trim();
  if (!raw || raw.length > MAX_MEDIA_URL_LENGTH) return false;

  // A same-origin asset path is handled by `parseMediaReference`, not here.
  if (raw.startsWith('/')) return false;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  // `https://user:pass@host/` hands a credential to a third party and is never a
  // legitimate image address.
  if (url.username || url.password) return false;

  const hostname = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(hostname)) return false;
  // A single-label host is an intranet name, not a public media host.
  if (!hostname.includes('.')) return false;

  return true;
}

/**
 * Classify a stored media reference, or null when it is neither form.
 *
 * An asset path wins over the external rules, because `/api/media/<id>` is a
 * same-origin path that the external checker deliberately refuses.
 */
export function parseMediaReference(value: unknown): MediaReference | null {
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;

  const assetId = assetIdFromMediaPath(raw);
  if (assetId) return { kind: 'asset', id: assetId };

  if (isAcceptableExternalMediaUrl(raw)) {
    return { kind: 'external', url: raw };
  }

  return null;
}

/** The asset ids inside a list of references, deduplicated. */
export function referencedAssetIds(values: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    const parsed = parseMediaReference(value);
    if (parsed?.kind === 'asset') ids.add(parsed.id);
  }
  return [...ids];
}

/**
 * Every `/api/media/<id>` reference inside a JSON document.
 *
 * Reward tiers and similar authored JSON are stored opaquely, so there is no DTO
 * field to validate. Any asset reference found inside them still has to be the
 * caller's, otherwise the JSON blob would be an unchecked way to point a public
 * surface at somebody else's upload. Only references in our own shape are
 * collected: external URLs inside JSON are not fetched or asserted here.
 */
export function collectMediaReferences(
  value: unknown,
  depth = 0,
): string[] {
  if (depth > 8) return [];

  if (typeof value === 'string') {
    return assetIdFromMediaPath(value.trim()) ? [value.trim()] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectMediaReferences(entry, depth + 1));
  }

  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((entry) =>
      collectMediaReferences(entry, depth + 1),
    );
  }

  return [];
}
