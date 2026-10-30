import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import {
  MediaStorageError,
  MediaStoragePort,
  UploadTarget,
} from './media-storage.port';

/**
 * The fail-closed adapter.
 *
 * Selected when no storage provider is configured. Every operation refuses with
 * `503 MEDIA_STORAGE_NOT_CONFIGURED` instead of writing to a local directory, a
 * fixture bucket or an in-memory map. A staging or production deployment with no
 * provider must behave like a feature that is not switched on - never like a
 * feature that silently accepts a file it cannot keep.
 *
 * `isConfigured()` is the single source of truth the API route and the UI use to
 * say so before a creator picks a file.
 */
@Injectable()
export class DisabledMediaAdapter implements MediaStoragePort {
  readonly provider = 'disabled' as const;
  readonly bucket: string;

  constructor(config: ConfigService<Env, true>) {
    this.bucket = config.get('MEDIA_BUCKET', { infer: true });
  }

  isConfigured(): boolean {
    return false;
  }

  private refuse(): never {
    throw new MediaStorageError(
      'MEDIA_STORAGE_NOT_CONFIGURED',
      'Media uploads are not enabled on this deployment.',
    );
  }

  createUpload(): Promise<UploadTarget> {
    return Promise.reject(this.refuse());
  }

  stat(): Promise<null> {
    return Promise.reject(this.refuse());
  }

  readHead(): Promise<null> {
    return Promise.reject(this.refuse());
  }

  createReadUrl(): Promise<never> {
    return Promise.reject(this.refuse());
  }

  remove(): Promise<void> {
    return Promise.reject(this.refuse());
  }
}
