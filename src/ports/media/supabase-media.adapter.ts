import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import {
  MediaStorageError,
  MediaStoragePort,
  ObjectHead,
  SignedReadUrl,
  StoredObject,
  UploadTarget,
} from './media-storage.port';

/**
 * Supabase Storage adapter.
 *
 * Uses the Storage REST API with the service-role key held by this process only.
 * The browser never receives that key: it receives one short-lived signed upload
 * target, which authorises exactly one object key that this server chose.
 *
 * Scope of the key is the whole project, so every call here must already have
 * passed an ownership check in the service layer. This adapter performs no
 * authorisation of its own.
 *
 * The signed URLs are bearer credentials for the objects they name. They are
 * returned to the caller and never logged, stored, or included in an error body.
 */

const STORAGE_PATH = '/storage/v1';
const REQUEST_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class SupabaseMediaAdapter implements MediaStoragePort {
  readonly provider = 'supabase' as const;
  private readonly logger = new Logger(SupabaseMediaAdapter.name);
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  readonly bucket: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    const url = config.get('SUPABASE_URL', { infer: true }) ?? '';
    this.baseUrl = `${url.replace(/\/+$/, '')}${STORAGE_PATH}`;
    this.serviceKey = config.get('SUPABASE_SERVICE_ROLE_KEY', { infer: true }) ?? '';
    this.bucket = config.get('MEDIA_BUCKET', { infer: true });
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.serviceKey);
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new MediaStorageError(
        'MEDIA_STORAGE_NOT_CONFIGURED',
        'Media storage is not configured for this deployment.',
      );
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.serviceKey,
      authorization: `Bearer ${this.serviceKey}`,
      ...extra,
    };
  }

  /** The bucket-relative path segment, escaped per segment. */
  private objectPath(key: string): string {
    const segments = key.split('/').filter(Boolean).map(encodeURIComponent);
    if (segments.length === 0) {
      throw new MediaStorageError(
        'MEDIA_STORAGE_REJECTED',
        'An object key is required.',
        500,
      );
    }
    return segments.join('/');
  }

  private async request(
    path: string,
    init: RequestInit & { expect?: number[] } = {},
  ): Promise<Response> {
    this.assertConfigured();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // A network failure or a timeout. The provider's message is not forwarded
      // because it can contain the object key.
      throw new MediaStorageError(
        'MEDIA_STORAGE_UNAVAILABLE',
        'Media storage could not be reached.',
      );
    }

    const expected = init.expect ?? [];
    if (expected.length > 0) {
      if (!expected.includes(response.status)) {
        this.logger.warn(
          `storage request failed: ${response.status} ${init.method ?? 'GET'} ${path.split('?')[0]}`,
        );
        throw new MediaStorageError(
          'MEDIA_STORAGE_UNAVAILABLE',
          'Media storage rejected the request.',
        );
      }
    } else if (!response.ok) {
      this.logger.warn(
        `storage request failed: ${response.status} ${init.method ?? 'GET'} ${path.split('?')[0]}`,
      );
      throw new MediaStorageError(
        'MEDIA_STORAGE_UNAVAILABLE',
        'Media storage rejected the request.',
      );
    }

    return response;
  }

  async createUpload(input: {
    key: string;
    contentType: string;
    byteSize: number;
  }): Promise<UploadTarget> {
    this.assertConfigured();
    const ttl = this.config.get('MEDIA_UPLOAD_URL_TTL_SECONDS', { infer: true });
    const objectPath = this.objectPath(input.key);

    const response = await this.request(
      `/object/upload/sign/${encodeURIComponent(this.bucket)}/${objectPath}`,
      {
        body: JSON.stringify({ expiresIn: ttl }),
        headers: this.headers({ 'content-type': 'application/json' }),
        method: 'POST',
      },
    );

    const payload: unknown = await response.json().catch(() => null);
    const relativeUrl = isRecord(payload) && typeof payload.url === 'string' ? payload.url : '';
    if (!relativeUrl) {
      throw new MediaStorageError(
        'MEDIA_STORAGE_UNAVAILABLE',
        'Media storage did not return an upload target.',
      );
    }

    return {
      // The signed URL is absolute once joined to the project base; the API
      // returns the relative form and the base is always this service's own.
      url: `${this.baseUrl}${relativeUrl.startsWith('/') ? '' : '/'}${relativeUrl}`,
      method: 'PUT',
      headers: {
        // The declared type is copied from the verified allowlist, never from the
        // browser's `File.type`, so the stored metadata cannot claim `text/html`.
        'content-type': input.contentType,
        // Never overwrite an existing object at this key.
        'x-upsert': 'false',
      },
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      key: input.key,
    };
  }

  /** A signed download URL. Not cached: it is a time-limited credential. */
  private async signedObjectUrl(key: string, ttlSeconds: number): Promise<string> {
    const objectPath = this.objectPath(key);
    const response = await this.request(
      `/object/sign/${encodeURIComponent(this.bucket)}/${objectPath}`,
      {
        body: JSON.stringify({ expiresIn: ttlSeconds }),
        headers: this.headers({ 'content-type': 'application/json' }),
        method: 'POST',
      },
    );

    const payload: unknown = await response.json().catch(() => null);
    const signedPath =
      isRecord(payload) && typeof payload.signedURL === 'string' ? payload.signedURL : '';
    if (!signedPath) {
      throw new MediaStorageError(
        'MEDIA_STORAGE_UNAVAILABLE',
        'Media storage did not return a read URL.',
      );
    }

    return `${this.baseUrl}${signedPath.startsWith('/') ? '' : '/'}${signedPath}`;
  }

  async createReadUrl(key: string, ttlSeconds: number): Promise<SignedReadUrl> {
    const url = await this.signedObjectUrl(key, ttlSeconds);
    return {
      url,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  async stat(key: string): Promise<StoredObject | null> {
    const url = await this.signedObjectUrl(key, 60);

    const head = await fetch(url, {
      cache: 'no-store',
      method: 'HEAD',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null);

    if (head?.ok) {
      const length = Number(head.headers.get('content-length') ?? '');
      return {
        byteSize: Number.isFinite(length) && length >= 0 ? length : 0,
        contentType: head.headers.get('content-type'),
      };
    }

    // Some deployments answer a HEAD on a signed object URL with 405. A one-byte
    // ranged GET gives the same facts from `content-range`.
    if (!head || head.status === 405 || head.status === 501) {
      const ranged = await this.readRange(url, 1);
      if (!ranged) return null;
      return { byteSize: ranged.byteSize, contentType: ranged.contentType };
    }

    if (head.status === 404 || head.status === 400) return null;

    throw new MediaStorageError(
      'MEDIA_STORAGE_UNAVAILABLE',
      'Media storage could not describe the object.',
    );
  }

  private async readRange(
    url: string,
    bytes: number,
  ): Promise<ObjectHead | null> {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { range: `bytes=0-${Math.max(0, bytes - 1)}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null);

    if (!response) {
      throw new MediaStorageError(
        'MEDIA_STORAGE_UNAVAILABLE',
        'Media storage could not be reached.',
      );
    }

    if (response.status === 404 || response.status === 400) return null;
    if (!response.ok) {
      throw new MediaStorageError(
        'MEDIA_STORAGE_UNAVAILABLE',
        'Media storage could not read the object.',
      );
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    const contentRange = response.headers.get('content-range') ?? '';
    const total = Number(contentRange.split('/')[1] ?? '');
    const byteSize =
      Number.isFinite(total) && total > 0 ? total : buffer.byteLength;

    return {
      byteSize,
      bytes: buffer,
      contentType: response.headers.get('content-type'),
    };
  }

  async readHead(key: string, bytes: number): Promise<ObjectHead | null> {
    const url = await this.signedObjectUrl(key, 60);
    return this.readRange(url, bytes);
  }

  async remove(key: string): Promise<void> {
    this.assertConfigured();
    const objectPath = this.objectPath(key);

    const response = await fetch(
      `${this.baseUrl}/object/${encodeURIComponent(this.bucket)}/${objectPath}`,
      {
        cache: 'no-store',
        headers: this.headers(),
        method: 'DELETE',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    ).catch(() => null);

    if (!response) {
      throw new MediaStorageError(
        'MEDIA_STORAGE_UNAVAILABLE',
        'Media storage could not be reached.',
      );
    }

    // Already gone is the desired end state, so 404 is success here.
    if (response.ok || response.status === 404) return;

    // 400 is what the storage API returns for a path it cannot resolve.
    if (response.status === 400) return;

    throw new MediaStorageError(
      'MEDIA_STORAGE_UNAVAILABLE',
      'Media storage could not delete the object.',
    );
  }
}
