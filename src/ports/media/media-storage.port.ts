/**
 * Port: object storage for creator media.
 *
 * The application never learns which provider holds a byte. It asks for an upload
 * target, a short-lived read URL, a stat and a delete. Supabase is implemented
 * today; S3 is the next adapter and changes nothing above this line
 * (docs/media/s3-migration.md).
 *
 * Two things this contract deliberately does not offer:
 *
 * - no public URL builder, because a URL that does not expire cannot express
 *   "this draft is not published yet", and
 * - no credential accessor, so no service key can leak upward into a controller,
 *   a projection or a log line.
 *
 * All methods are idempotent from the caller's point of view: deleting a missing
 * object succeeds, and statting a missing object returns `null` rather than
 * throwing.
 */

export type MediaStorageProvider = 'supabase' | 's3' | 'disabled';

export type UploadTarget = {
  /** Absolute URL the browser PUTs the bytes to. */
  url: string;
  method: 'PUT';
  /**
   * Headers the browser must send verbatim. They are provider-shaped but the
   * client treats them as opaque key/value pairs, so it never imports a vendor.
   */
  headers: Record<string, string>;
  expiresAt: string;
  /** The object key, for logging and diagnostics. Never a credential. */
  key: string;
};

export type StoredObject = {
  byteSize: number;
  /** What the provider recorded; may differ from what the browser claimed. */
  contentType: string | null;
};

export type SignedReadUrl = {
  url: string;
  expiresAt: string;
};

export type ObjectHead = StoredObject & {
  /** The leading bytes, for magic-byte verification. */
  bytes: Uint8Array;
};

export interface MediaStoragePort {
  readonly provider: MediaStorageProvider;
  readonly bucket: string;

  /** False when the deployment selected `disabled` or lacks credentials. */
  isConfigured(): boolean;

  createUpload(input: {
    key: string;
    contentType: string;
    byteSize: number;
  }): Promise<UploadTarget>;

  /** Provider-side metadata, or null when the object does not exist. */
  stat(key: string): Promise<StoredObject | null>;

  /** A short ranged read used to verify content. Null when absent. */
  readHead(key: string, bytes: number): Promise<ObjectHead | null>;

  /** A URL that expires. Never persisted and never returned to a cache. */
  createReadUrl(key: string, ttlSeconds: number): Promise<SignedReadUrl>;

  /** Idempotent: removing an absent object is not an error. */
  remove(key: string): Promise<void>;
}

export const MEDIA_STORAGE_PORT = Symbol('MEDIA_STORAGE_PORT');

export type MediaStorageErrorCode =
  | 'MEDIA_STORAGE_NOT_CONFIGURED'
  | 'MEDIA_STORAGE_UNAVAILABLE'
  | 'MEDIA_STORAGE_REJECTED';

/**
 * A storage failure with a stable code.
 *
 * The HTTP status is carried but never the provider's response body: a Supabase
 * error payload can echo the bucket and the object key, and neither belongs in a
 * client response.
 */
export class MediaStorageError extends Error {
  readonly code: MediaStorageErrorCode;
  readonly status: number;

  constructor(code: MediaStorageErrorCode, message: string, status = 503) {
    super(message);
    this.name = 'MediaStorageError';
    this.code = code;
    this.status = status;
  }
}
