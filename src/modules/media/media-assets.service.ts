import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Env } from '../../config/env.validation';
import {
  IMAGE_SNIFF_BYTES,
  detectImage,
  type DetectedImageType,
} from '../../common/media/image-metadata';
import {
  buildObjectKey,
  mediaPathFor,
  normaliseDisplayName,
  assetIdFromMediaPath,
} from '../../common/media/media-key';
import {
  isAcceptableExternalMediaUrl,
  parseMediaReference,
} from '../../common/media/media-ref';
import {
  MEDIA_STORAGE_PORT,
  MediaStorageError,
  MediaStoragePort,
} from '../../ports/media/media-storage.port';
import type {
  CreateMediaUploadDto,
  MediaAssetCategoryName,
  UpdateMediaAssetDto,
} from './dto/media.dto';

/** Campaign states that are visible to the public (mirrors the web projection). */
const PUBLIC_CAMPAIGN_STATUSES = ['ACTIVE', 'FUNDED', 'FAILED', 'COMPLETED'] as const;

/** Declared type -> object-key extension. The extension never comes from a name. */
const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

type Viewer = { id: string; role: string };

type AssetWithBindings = Prisma.MediaAssetGetPayload<{
  include: {
    idea: { select: { status: true } };
    campaign: { select: { status: true } };
  };
}>;

/** The columns every projection needs, independent of any binding include. */
type MediaAssetRow = Pick<
  AssetWithBindings,
  | 'id'
  | 'category'
  | 'status'
  | 'mimeType'
  | 'byteSize'
  | 'width'
  | 'height'
  | 'displayName'
  | 'altText'
  | 'caption'
  | 'createdAt'
  | 'objectKey'
  | 'ownerId'
>;

const BINDINGS_INCLUDE = {
  campaign: { select: { status: true } },
  idea: { select: { status: true } },
} as const;

export type MediaAssetView = {
  id: string;
  /** The stable reference a creator's content stores. */
  src: string;
  category: MediaAssetCategoryName;
  status: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  displayName: string;
  altText: string | null;
  caption: string | null;
  createdAt: string;
  /** A short-lived signed URL for an owner preview. Never persisted. */
  previewUrl?: string;
};

export type MediaCapabilities = {
  uploadsEnabled: boolean;
  provider: string;
  maxImageBytes: number;
  allowedImageTypes: string[];
  videoUploadEnabled: false;
  youtubeMetadataEnabled: boolean;
};

/**
 * Creator media.
 *
 * The invariants this service exists to hold:
 *
 * - an upload target is issued only for a server-chosen key and an allowlisted
 *   content type;
 * - an asset becomes `READY` only after the bytes themselves have been read back
 *   and verified, so `status` is evidence rather than optimism;
 * - a read requires either ownership or a published bound record, so a guessed
 *   asset id cannot reach a draft;
 * - attaching an asset requires ownership, so a creator cannot point their idea
 *   cover at somebody else's private upload;
 * - deletion is idempotent and never removes bytes that belong to another owner.
 */
@Injectable()
export class MediaAssetsService {
  private readonly logger = new Logger(MediaAssetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MEDIA_STORAGE_PORT) private readonly storage: MediaStoragePort,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ---------------------------------------------------------------- policy ---

  private allowedImageTypes(): string[] {
    return this.config
      .get('MEDIA_ALLOWED_IMAGE_TYPES', { infer: true })
      .split(',')
      .map((type) => type.trim().toLowerCase())
      .filter((type) => type in CONTENT_TYPE_EXTENSIONS);
  }

  private maxImageBytes(): number {
    return this.config.get('MEDIA_IMAGE_MAX_BYTES', { infer: true });
  }

  private readTtl(): number {
    return this.config.get('MEDIA_READ_URL_TTL_SECONDS', { infer: true });
  }

  capabilities(): MediaCapabilities {
    return {
      allowedImageTypes: this.allowedImageTypes(),
      maxImageBytes: this.maxImageBytes(),
      provider: this.storage.provider,
      uploadsEnabled: this.storage.isConfigured(),
      videoUploadEnabled: false,
      youtubeMetadataEnabled: this.config.get('YOUTUBE_METADATA_ENABLED', {
        infer: true,
      }),
    };
  }

  /** Re-throw a storage failure as an HTTP response without its provider body. */
  private asHttp(error: unknown): never {
    if (error instanceof MediaStorageError) {
      if (error.code === 'MEDIA_STORAGE_NOT_CONFIGURED') {
        throw new ServiceUnavailableException({
          code: 'MEDIA_STORAGE_NOT_CONFIGURED',
          message: 'Media uploads are not enabled on this deployment.',
        });
      }
      // The adapter's own text is deliberately not forwarded: a provider message
      // can name the bucket or the object key (NFR-09).
      throw new ServiceUnavailableException({
        code: 'MEDIA_STORAGE_UNAVAILABLE',
        message: 'Media storage is temporarily unavailable. Try again shortly.',
      });
    }
    throw error;
  }

  private assertConfigured(): void {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException({
        code: 'MEDIA_STORAGE_NOT_CONFIGURED',
        message: 'Media uploads are not enabled on this deployment.',
      });
    }
  }

  // ---------------------------------------------------------------- uploads ---

  async createUpload(userId: string, dto: CreateMediaUploadDto) {
    this.assertConfigured();

    const declared = dto.contentType.trim().toLowerCase();
    const allowed = this.allowedImageTypes();
    if (!allowed.includes(declared)) {
      throw new UnsupportedMediaTypeException({
        code: 'MEDIA_TYPE_NOT_ALLOWED',
        message: 'That file type is not accepted here.',
        allowedTypes: allowed,
      });
    }

    const max = this.maxImageBytes();
    if (dto.byteSize > max) {
      throw new PayloadTooLargeException({
        code: 'MEDIA_FILE_TOO_LARGE',
        message: `Images must be ${Math.floor(max / (1024 * 1024))} MB or smaller.`,
        maxBytes: max,
      });
    }

    await this.assertWithinDailyLimit(userId);

    const category: MediaAssetCategoryName = dto.category ?? 'OTHER';
    const extension = CONTENT_TYPE_EXTENSIONS[declared] ?? 'bin';
    const key = buildObjectKey({ category, extension });

    let target;
    try {
      target = await this.storage.createUpload({
        byteSize: dto.byteSize,
        contentType: declared,
        key,
      });
    } catch (error) {
      this.asHttp(error);
    }

    const asset = await this.prisma.mediaAsset.create({
      data: {
        altText: dto.altText?.trim() || null,
        bucket: this.storage.bucket,
        byteSize: 0,
        caption: dto.caption?.trim() || null,
        category,
        displayName: normaliseDisplayName(dto.displayName, `image.${extension}`),
        mimeType: declared,
        objectKey: key,
        ownerId: userId,
        provider: this.storage.provider,
        status: 'PENDING',
      },
    });

    return {
      asset: this.toView(asset),
      upload: target,
    };
  }

  private async assertWithinDailyLimit(userId: string): Promise<void> {
    const limit = this.config.get('MEDIA_DAILY_UPLOAD_LIMIT', { infer: true });
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    // Every attempt counts, including rejected ones: a loop that uploads garbage
    // and fails verification must still be bounded.
    const used = await this.prisma.mediaAsset.count({
      where: { createdAt: { gte: startOfDay }, ownerId: userId },
    });

    if (used >= limit) {
      throw new HttpException(
        {
          code: 'MEDIA_UPLOAD_LIMIT_REACHED',
          message: 'You have reached the daily upload limit. Try again tomorrow.',
          limit,
        },
        429,
      );
    }
  }

  /**
   * Verify the bytes and make the asset attachable.
   *
   * Idempotent: a second call on a `READY` asset returns the same projection
   * without touching storage, so a retried request cannot fail a successful
   * upload.
   */
  async completeUpload(userId: string, assetId: string) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, ownerId: userId },
    });
    // 404 rather than 403 for another user's id: an id is not a discovery tool.
    if (!asset) throw new NotFoundException('Media asset not found');

    if (asset.status === 'READY') {
      return this.present(asset);
    }
    if (asset.status === 'DELETED') {
      throw new ConflictException({
        code: 'MEDIA_ASSET_DELETED',
        message: 'That upload was removed.',
      });
    }
    if (asset.status === 'REJECTED') {
      throw new ConflictException({
        code: 'MEDIA_ASSET_REJECTED',
        message: 'That upload did not pass verification. Choose the file again.',
      });
    }

    this.assertConfigured();

    let stored;
    try {
      stored = await this.storage.stat(asset.objectKey);
    } catch (error) {
      this.asHttp(error);
    }

    if (!stored) {
      // The row stays PENDING: the browser may have failed mid-PUT and can retry
      // against the same signed target while it is still valid.
      throw new ConflictException({
        code: 'MEDIA_UPLOAD_NOT_RECEIVED',
        message: 'The file has not arrived yet. Retry the upload.',
      });
    }

    if (stored.byteSize > this.maxImageBytes()) {
      throw await this.reject(asset, {
        code: 'MEDIA_FILE_TOO_LARGE',
        message: 'That file is larger than this deployment accepts.',
        status: 413,
      });
    }

    if (stored.byteSize <= 0) {
      throw await this.reject(asset, {
        code: 'MEDIA_FILE_EMPTY',
        message: 'That file is empty.',
        status: 400,
      });
    }

    let head;
    try {
      head = await this.storage.readHead(asset.objectKey, IMAGE_SNIFF_BYTES);
    } catch (error) {
      this.asHttp(error);
    }

    if (!head) {
      throw new ConflictException({
        code: 'MEDIA_UPLOAD_NOT_RECEIVED',
        message: 'The file has not arrived yet. Retry the upload.',
      });
    }

    const detected = detectImage(head.bytes);
    if (!detected) {
      throw await this.reject(asset, {
        code: 'MEDIA_CONTENT_UNSUPPORTED',
        message:
          'That file is not a JPEG, PNG or WebP image. SVG and other formats are not accepted.',
        status: 415,
      });
    }

    const detectedType: DetectedImageType = detected.mimeType;

    // The declared type chose the key's extension, so a mismatch would leave an
    // object whose extension lies about its bytes.
    if (detectedType !== asset.mimeType) {
      throw await this.reject(asset, {
        code: 'MEDIA_TYPE_MISMATCH',
        message: 'The file content does not match the type that was declared.',
        status: 415,
      });
    }

    const providerType = (stored.contentType ?? '').split(';')[0]?.trim().toLowerCase();
    if (providerType && providerType !== detectedType) {
      throw await this.reject(asset, {
        code: 'MEDIA_TYPE_MISMATCH',
        message: 'The stored file type does not match its content.',
        status: 415,
      });
    }

    const updated = await this.prisma.mediaAsset.update({
      data: {
        byteSize: stored.byteSize,
        height: detected.height,
        mimeType: detectedType,
        status: 'READY',
        width: detected.width,
      },
      where: { id: asset.id },
    });

    return this.present(updated);
  }

  /** Remove the misleading bytes, then record why the asset is unusable. */
  private async reject(
    asset: { id: string; objectKey: string },
    failure: { code: string; message: string; status: number },
  ): Promise<HttpException> {
    try {
      await this.storage.remove(asset.objectKey);
    } catch (error) {
      // The object is unusable either way. Failing to remove it is logged for
      // the cleanup pass, not surfaced as a different error to the creator.
      this.logger.warn(
        `rejected media object could not be removed (${asset.id}): ${
          error instanceof MediaStorageError ? error.code : 'unknown'
        }`,
      );
    }

    await this.prisma.mediaAsset.update({
      data: { byteSize: 0, status: 'REJECTED' },
      where: { id: asset.id },
    });

    return new HttpException(
      { code: failure.code, message: failure.message },
      failure.status,
    );
  }

  // ------------------------------------------------------------------ reads ---

  private toView(asset: MediaAssetRow): MediaAssetView {
    return {
      altText: asset.altText,
      byteSize: asset.byteSize,
      caption: asset.caption,
      category: asset.category as MediaAssetCategoryName,
      createdAt: asset.createdAt.toISOString(),
      displayName: asset.displayName,
      height: asset.height,
      id: asset.id,
      mimeType: asset.mimeType,
      src: mediaPathFor(asset.id),
      status: asset.status,
      width: asset.width,
    };
  }

  /** The asset plus an owner-only preview URL. */
  private async present(asset: MediaAssetRow) {
    const view = this.toView(asset);
    if (asset.status !== 'READY' || !this.storage.isConfigured()) return view;

    try {
      const read = await this.storage.createReadUrl(asset.objectKey, this.readTtl());
      return { ...view, previewUrl: read.url };
    } catch {
      // A preview is a convenience; withholding it must not fail the upload.
      return view;
    }
  }

  async getForViewer(viewer: Viewer | undefined, assetId: string) {
    const asset = await this.prisma.mediaAsset.findUnique({
      include: BINDINGS_INCLUDE,
      where: { id: assetId },
    });
    if (!asset) throw new NotFoundException('Media asset not found');

    if (!this.canRead(asset, viewer)) {
      throw new NotFoundException('Media asset not found');
    }

    const view = this.toView(asset);
    if (asset.status !== 'READY') return view;

    // Only the owner and admins get the signed URL from the metadata route; a
    // public reader goes through `/media/:id/url` so the bytes are not cached
    // alongside a credential.
    if (viewer && (viewer.id === asset.ownerId || viewer.role === 'ADMIN')) {
      return this.present(asset);
    }
    return view;
  }

  /**
   * A short-lived signed read URL.
   *
   * Ownership, or a published bound record, is the whole authorisation. An
   * unattached upload is owner-only; a `PENDING` or `REJECTED` asset is never
   * served, because its bytes have not been verified.
   */
  async readUrl(viewer: Viewer | undefined, assetId: string) {
    const asset = await this.prisma.mediaAsset.findUnique({
      include: BINDINGS_INCLUDE,
      where: { id: assetId },
    });
    if (!asset || asset.status !== 'READY') {
      throw new NotFoundException('Media asset not found');
    }
    if (!this.canRead(asset, viewer)) {
      throw new NotFoundException('Media asset not found');
    }

    this.assertConfigured();
    try {
      const read = await this.storage.createReadUrl(asset.objectKey, this.readTtl());
      return {
        expiresAt: read.expiresAt,
        // Whether the asset may be served to somebody with no session, so the web
        // layer can cache a public redirect and must never cache a private one.
        public: this.canRead(asset, undefined),
        url: read.url,
      };
    } catch (error) {
      this.asHttp(error);
    }
  }

  private canRead(asset: AssetWithBindings, viewer?: Viewer): boolean {
    if (asset.ownerId === viewer?.id) return true;
    if (viewer?.role === 'ADMIN') return true;
    if (asset.status !== 'READY') return false;

    if (asset.ideaId && asset.idea) return asset.idea.status !== 'DRAFT';
    if (asset.campaignId && asset.campaign) {
      return (PUBLIC_CAMPAIGN_STATUSES as readonly string[]).includes(
        asset.campaign.status,
      );
    }
    // An avatar for a completed public profile is public; an unattached upload is
    // not, even when its bytes are verified.
    if (asset.creatorProfileUserId) return true;

    return false;
  }

  // ----------------------------------------------------------------- writes ---

  async update(userId: string, assetId: string, dto: UpdateMediaAssetDto) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, ownerId: userId },
    });
    if (!asset) throw new NotFoundException('Media asset not found');
    if (asset.status === 'DELETED') {
      throw new ConflictException({
        code: 'MEDIA_ASSET_DELETED',
        message: 'That upload was removed.',
      });
    }

    const updated = await this.prisma.mediaAsset.update({
      data: {
        ...(dto.altText !== undefined ? { altText: dto.altText.trim() || null } : {}),
        ...(dto.caption !== undefined
          ? { caption: dto.caption.trim() || null }
          : {}),
        ...(dto.displayName !== undefined
          ? { displayName: normaliseDisplayName(dto.displayName, asset.displayName) }
          : {}),
      },
      where: { id: asset.id },
    });

    return this.present(updated);
  }

  /**
   * Delete an asset and its bytes.
   *
   * Idempotent by design: a repeated request is a success, not a 404, so a client
   * retry after a dropped response cannot present as an error. Another user's id
   * is a 404, so the endpoint cannot be used to probe for existence.
   */
  async remove(userId: string, assetId: string) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, ownerId: userId },
    });
    if (!asset) throw new NotFoundException('Media asset not found');

    if (asset.status === 'DELETED') {
      return { deleted: true, id: asset.id };
    }

    if (this.storage.isConfigured()) {
      try {
        await this.storage.remove(asset.objectKey);
      } catch (error) {
        if (error instanceof MediaStorageError) {
          // Do not leave the creator unable to detach media because the provider
          // is briefly down: record the deletion so no surface can serve it, and
          // let the cleanup pass retry the object.
          this.logger.warn(
            `media object removal deferred (${asset.id}): ${error.code}`,
          );
        } else {
          throw error;
        }
      }
    }

    await this.prisma.mediaAsset.update({
      data: { deletedAt: new Date(), status: 'DELETED' },
      where: { id: asset.id },
    });

    return { deleted: true, id: asset.id };
  }

  // -------------------------------------------------------------- attaching ---

  /**
   * Every uploaded reference in a create/update body must belong to the caller
   * and be verified before the content may point at it.
   *
   * External `https` references are checked for shape only; they are somebody
   * else's host and the browser loads them directly. An unknown scheme is a 400,
   * not a silent drop, because a dropped cover is a creator losing work quietly.
   */
  async assertAttachable(
    userId: string,
    values: readonly (string | null | undefined)[],
  ): Promise<void> {
    const ids = new Set<string>();

    for (const value of values) {
      if (value === null || value === undefined) continue;
      if (typeof value !== 'string' || !value.trim()) continue;

      const parsed = parseMediaReference(value);
      if (!parsed) {
        throw new BadRequestException({
          code: 'MEDIA_REFERENCE_INVALID',
          message:
            'Media must be an uploaded image or an https link to one.',
        });
      }
      if (parsed.kind === 'asset') ids.add(parsed.id);
    }

    if (ids.size === 0) return;

    const assets = await this.prisma.mediaAsset.findMany({
      select: { id: true, ownerId: true, status: true },
      where: { id: { in: [...ids] } },
    });
    const byId = new Map(assets.map((asset) => [asset.id, asset]));

    for (const id of ids) {
      const asset = byId.get(id);
      if (!asset) {
        throw new BadRequestException({
          code: 'MEDIA_ASSET_NOT_FOUND',
          message: 'One of the attached images no longer exists.',
        });
      }
      if (asset.ownerId !== userId) {
        // 403 rather than 400: this is an authorisation failure even though the
        // request is otherwise well formed.
        throw new ForbiddenException({
          code: 'MEDIA_ASSET_NOT_OWNED',
          message: 'That image belongs to another account.',
        });
      }
      if (asset.status !== 'READY') {
        throw new BadRequestException({
          code: 'MEDIA_ASSET_NOT_READY',
          message: 'One of the attached images has not finished uploading.',
        });
      }
    }
  }

  /** The asset id inside a media reference, for binding a slot to its row. */
  assetIdOf(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    return assetIdFromMediaPath(value.trim());
  }

  /**
   * Bind verified assets to the record they were attached to.
   *
   * Called after the content's own write commits, so a failed content save never
   * leaves an asset pointing at a draft that does not exist.
   */
  async bindToIdea(
    userId: string,
    ideaId: string,
    values: readonly (string | null | undefined)[],
  ): Promise<void> {
    const ids = this.verifiedIdsFrom(values);
    if (ids.length === 0) return;

    await this.prisma.mediaAsset.updateMany({
      data: { ideaId },
      where: { id: { in: ids }, ownerId: userId },
    });
  }

  async bindToCampaign(
    userId: string,
    campaignId: string,
    values: readonly (string | null | undefined)[],
  ): Promise<void> {
    const ids = this.verifiedIdsFrom(values);
    if (ids.length === 0) return;

    await this.prisma.mediaAsset.updateMany({
      data: { campaignId },
      where: { id: { in: ids }, ownerId: userId },
    });
  }

  /**
   * Point the creator's profile at one verified upload.
   *
   * Unlike a cover, an avatar is a single slot: binding a new image releases the
   * previous one, because only the picture a profile currently shows may be read
   * without a session. Clearing the avatar (a null or empty reference) releases
   * the slot without binding anything - the bytes stay with their owner, the
   * public reference goes away.
   */
  async bindToCreatorProfile(
    userId: string,
    value: string | null | undefined,
  ): Promise<void> {
    const [id] = this.verifiedIdsFrom([value]);

    await this.prisma.$transaction([
      this.prisma.mediaAsset.updateMany({
        data: { creatorProfileUserId: null },
        where: {
          creatorProfileUserId: userId,
          ...(id ? { id: { not: id } } : {}),
        },
      }),
      ...(id
        ? [
            this.prisma.mediaAsset.updateMany({
              data: { creatorProfileUserId: userId },
              where: { id, ownerId: userId },
            }),
          ]
        : []),
    ]);
  }

  private verifiedIdsFrom(
    values: readonly (string | null | undefined)[],
  ): string[] {
    const ids = new Set<string>();
    for (const value of values) {
      const id = this.assetIdOf(value);
      if (id) ids.add(id);
    }
    return [...ids];
  }

  /** True when a stored reference is an external `https` media URL. */
  isExternal(value: unknown): boolean {
    return isAcceptableExternalMediaUrl(value);
  }

  // --------------------------------------------------------------- cleanup ---

  /**
   * Remove upload targets that were never completed.
   *
   * Deliberately a callable pass rather than a queue: the repository has BullMQ,
   * but booting it makes Redis a hard dependency and a queue for a handful of
   * abandoned image uploads is more machinery than the problem needs. An operator
   * runs this on a schedule (docs/media/operations.md); it is safe to run by hand
   * and safe to run twice.
   */
  async purgeAbandoned(olderThanHours?: number) {
    const hours =
      olderThanHours ??
      this.config.getOrThrow('MEDIA_PENDING_RETENTION_HOURS', { infer: true });
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    const stale = await this.prisma.mediaAsset.findMany({
      select: { id: true, objectKey: true },
      take: 200,
      where: { createdAt: { lt: cutoff }, status: 'PENDING' },
    });

    let removed = 0;
    for (const asset of stale) {
      if (this.storage.isConfigured()) {
        try {
          await this.storage.remove(asset.objectKey);
        } catch (error) {
          this.logger.warn(
            `abandoned media object removal failed (${asset.id}): ${
              error instanceof MediaStorageError ? error.code : 'unknown'
            }`,
          );
          continue;
        }
      }

      await this.prisma.mediaAsset.update({
        data: { deletedAt: new Date(), status: 'DELETED' },
        where: { id: asset.id },
      });
      removed += 1;
    }

    return { examined: stale.length, removed };
  }
}
