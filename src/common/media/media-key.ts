/**
 * Media identity and object keys.
 *
 * Two rules hold here and nowhere else:
 *
 * 1. **The object key is built by the server from non-user input.** No part of it
 *    comes from the uploaded filename, so `..`, a leading slash, a null byte or a
 *    `.html` suffix cannot reach the bucket. The extension is chosen from the
 *    verified content type, not from the name the uploader used.
 *
 * 2. **The public reference is `/api/media/<id>`, not a storage URL.** That keeps
 *    the provider out of every stored document and lets the read path decide
 *    whether the asset may be served at all.
 *
 * Pure so both are unit-tested without a database or a storage provider.
 */

import { randomUUID } from 'node:crypto';

export const MEDIA_PATH_PREFIX = '/api/media/';

/**
 * A Prisma cuid: lowercase alphanumerics, generated server-side. The bound is
 * deliberately tight - a 21-character cuid today, with room for a longer format
 * without accepting an arbitrary string as an asset id.
 */
const ASSET_ID = /^[a-z0-9]{20,40}$/;

/** The stable public path for an asset. */
export function mediaPathFor(assetId: string): string {
  return `${MEDIA_PATH_PREFIX}${assetId}`;
}

/**
 * The asset id inside a `/api/media/<id>` reference, or null.
 *
 * Query strings, fragments, extra segments and trailing slashes are all refused:
 * the reference must be exactly the path this service mints.
 */
export function assetIdFromMediaPath(value: string): string | null {
  if (!value.startsWith(MEDIA_PATH_PREFIX)) return null;
  const id = value.slice(MEDIA_PATH_PREFIX.length);
  return ASSET_ID.test(id) ? id : null;
}

/** True when a stored `src` is one of our own asset references. */
export function isMediaPath(value: string): boolean {
  return assetIdFromMediaPath(value) !== null;
}

export type MediaObjectKeyInput = {
  category: string;
  /** From `IMAGE_EXTENSIONS`; never from a filename. */
  extension: string;
  /** Injected for testability. Defaults to now. */
  at?: Date;
  /** Injected for testability. Defaults to a random UUID. */
  nonce?: string;
};

/** `media/<category>/<yyyy>/<mm>/<nonce>.<ext>` - no owner id, no filename. */
export function buildObjectKey({
  at = new Date(),
  category,
  extension,
  nonce = randomUUID(),
}: MediaObjectKeyInput): string {
  const year = at.getUTCFullYear().toString();
  const month = (at.getUTCMonth() + 1).toString().padStart(2, '0');
  const segment = category.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const safeExtension = extension.toLowerCase().replace(/[^a-z0-9]/g, '');

  return `media/${segment}/${year}/${month}/${nonce}.${safeExtension}`;
}

/**
 * A display filename that is safe to show and store.
 *
 * This value never becomes a key. It is normalised so a crafted name cannot
 * break a log line, a header or a future `Content-Disposition`, and a name that is
 * empty after normalisation falls back to the type, never to the raw input.
 */
export function normaliseDisplayName(input: unknown, fallback: string): string {
  const raw = typeof input === 'string' ? input : '';
  const cleaned = raw
    // Control characters and the path separators that make a name look like a
    // path.
    .replace(/[\u0000-\u001f\u007f/\\]+/g, ' ')
    // Windows-reserved characters, so the same name is representable everywhere.
    .replace(/[<>:"|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim();

  if (!cleaned) return fallback;
  return cleaned.slice(0, 120);
}
