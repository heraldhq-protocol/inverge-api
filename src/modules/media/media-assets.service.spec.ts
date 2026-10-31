import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { MediaAssetsService } from './media-assets.service';
import {
  MediaStorageError,
  type MediaStoragePort,
  type ObjectHead,
  type StoredObject,
} from '../../ports/media/media-storage.port';

const OWNER = 'user-owner';
const OTHER = 'user-other';
const ASSET_ID = 'clx0mediaasset0001abcdef';
const OBJECT_KEY = 'media/idea-cover/2026/10/nonce.jpg';

/** A 100x50 PNG header, which is all verification reads. */
function pngHead(width = 100, height = 50): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

type AssetOverrides = {
  ownerId?: string;
  status?: string;
  mimeType?: string;
  idea?: { status: string } | null;
  campaign?: { status: string } | null;
  creatorProfileUserId?: string | null;
  ideaId?: string | null;
  campaignId?: string | null;
};

function asset(overrides: AssetOverrides = {}) {
  return {
    altText: null,
    bucket: 'inverge-media',
    byteSize: 1024,
    campaign: null,
    campaignId: null,
    caption: null,
    category: 'IDEA_COVER',
    createdAt: new Date('2026-10-30T10:00:00.000Z'),
    creatorProfileUserId: null,
    deletedAt: null,
    displayName: 'photo.jpg',
    durationSeconds: null,
    height: 50,
    id: ASSET_ID,
    idea: null,
    ideaId: null,
    mimeType: 'image/png',
    objectKey: OBJECT_KEY,
    ownerId: OWNER,
    provider: 'supabase',
    status: 'READY',
    updatedAt: new Date('2026-10-30T10:00:00.000Z'),
    width: 100,
    ...overrides,
  };
}

/**
 * Owner-scoped `findFirst`. The real query filters on `ownerId`, so a mock that
 * returned the row regardless would hide a missing ownership check.
 */
function findFirstReturning(row: ReturnType<typeof asset> | null) {
  return ({ where }: { where?: { ownerId?: string } } = {}) => {
    if (!row) return Promise.resolve(null);
    const wanted = where?.ownerId;
    if (typeof wanted === 'string' && wanted !== row.ownerId) {
      return Promise.resolve(null);
    }
    return Promise.resolve(row);
  };
}

function prismaMock() {
  return {
    mediaAsset: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(({ data }: { data: object }) =>
        Promise.resolve({ ...asset({ status: 'PENDING' }), ...data, id: ASSET_ID }),
      ),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn().mockImplementation(({ data, where }: { data: object; where: { id: string } }) =>
        Promise.resolve({ ...asset(), ...data, id: where.id }),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest
      .fn()
      .mockImplementation((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
  };
}

const DEFAULT_CONFIG: Record<string, unknown> = {
  MEDIA_ALLOWED_IMAGE_TYPES: 'image/jpeg,image/png,image/webp',
  MEDIA_DAILY_UPLOAD_LIMIT: 40,
  MEDIA_IMAGE_MAX_BYTES: 8 * 1024 * 1024,
  MEDIA_PENDING_RETENTION_HOURS: 24,
  MEDIA_READ_URL_TTL_SECONDS: 300,
  YOUTUBE_METADATA_ENABLED: false,
};

function configMock(overrides: Record<string, unknown> = {}) {
  const store = { ...DEFAULT_CONFIG, ...overrides };
  return {
    get: jest.fn((key: string) => store[key]),
    getOrThrow: jest.fn((key: string) => store[key]),
  } as never;
}

function storageMock(overrides: Partial<MediaStoragePort> = {}) {
  const storage = {
    bucket: 'inverge-media',
    createReadUrl: jest
      .fn()
      .mockResolvedValue({ expiresAt: '2026-10-30T11:00:00.000Z', url: 'https://storage.test/signed' }),
    createUpload: jest.fn().mockResolvedValue({
      expiresAt: '2026-10-30T10:15:00.000Z',
      headers: { 'content-type': 'image/png', 'x-upsert': 'false' },
      key: OBJECT_KEY,
      method: 'PUT',
      url: 'https://storage.test/upload',
    }),
    isConfigured: jest.fn().mockReturnValue(true),
    provider: 'supabase',
    readHead: jest
      .fn()
      .mockResolvedValue({ byteSize: 1024, bytes: pngHead(), contentType: 'image/png' } satisfies ObjectHead),
    remove: jest.fn().mockResolvedValue(undefined),
    stat: jest
      .fn()
      .mockResolvedValue({ byteSize: 1024, contentType: 'image/png' } satisfies StoredObject),
    ...overrides,
  } as unknown as MediaStoragePort;

  return storage;
}

function make(options: { config?: Record<string, unknown>; storage?: Partial<MediaStoragePort> } = {}) {
  const prisma = prismaMock();
  const storage = storageMock(options.storage);
  const service = new MediaAssetsService(
    prisma as never,
    storage,
    configMock(options.config),
  );
  return { prisma, service, storage };
}

describe('MediaAssetsService.capabilities', () => {
  it('#given a configured image provider #then the limits and format list are reported', () => {
    const { service } = make();

    expect(service.capabilities()).toEqual({
      allowedImageTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxImageBytes: 8 * 1024 * 1024,
      provider: 'supabase',
      uploadsEnabled: true,
      videoUploadEnabled: false,
      youtubeMetadataEnabled: false,
    });
  });

  it('#given no provider #then uploads are reported as unavailable', () => {
    const { service } = make({
      storage: { isConfigured: jest.fn().mockReturnValue(false), provider: 'disabled' },
    });

    expect(service.capabilities().uploadsEnabled).toBe(false);
  });

  it('#given a configured type list #then unknown types are dropped', () => {
    const { service } = make({
      config: { MEDIA_ALLOWED_IMAGE_TYPES: 'image/png,image/svg+xml' },
    });

    expect(service.capabilities().allowedImageTypes).toEqual(['image/png']);
  });
});

describe('MediaAssetsService.createUpload', () => {
  describe('#given no storage provider', () => {
    it('#then the request fails closed with 503', async () => {
      const { service } = make({
        storage: { isConfigured: jest.fn().mockReturnValue(false) },
      });

      await expect(
        service.createUpload(OWNER, { byteSize: 1024, contentType: 'image/png' }),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('#given an unsupported declared type', () => {
    it.each([['image/svg+xml'], ['application/pdf'], ['text/html'], ['image/gif']])(
      '#when the type is %s #then it is refused before any storage call',
      async (contentType) => {
        const { service, storage } = make();

        await expect(
          service.createUpload(OWNER, { byteSize: 1024, contentType }),
        ).rejects.toThrow(UnsupportedMediaTypeException);
        expect(storage.createUpload).not.toHaveBeenCalled();
      },
    );
  });

  describe('#given an oversized declaration', () => {
    it('#then it is refused before any storage call', async () => {
      const { service, storage } = make();

      await expect(
        service.createUpload(OWNER, { byteSize: 9 * 1024 * 1024, contentType: 'image/png' }),
      ).rejects.toThrow(PayloadTooLargeException);
      expect(storage.createUpload).not.toHaveBeenCalled();
    });
  });

  describe('#given the daily quota is spent', () => {
    it('#then the upload is refused with 429', async () => {
      const { service, prisma, storage } = make();
      prisma.mediaAsset.count.mockResolvedValue(40);

      const error = await service
        .createUpload(OWNER, { byteSize: 1024, contentType: 'image/png' })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect(storage.createUpload).not.toHaveBeenCalled();
    });
  });

  describe('#given an accepted upload', () => {
    it('#then the key is server-generated and the row starts PENDING', async () => {
      const { service, prisma, storage } = make();

      const result = await service.createUpload(OWNER, {
        byteSize: 2048,
        category: 'IDEA_COVER',
        contentType: 'image/png',
        displayName: '../../my cover.png',
      });

      expect(storage.createUpload).toHaveBeenCalledWith(
        expect.objectContaining({ contentType: 'image/png', key: expect.any(String) }),
      );
      const key = (storage.createUpload as jest.Mock).mock.calls[0][0].key as string;
      expect(key).toMatch(/^media\/idea-cover\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
      expect(key).not.toContain('..');

      expect(prisma.mediaAsset.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          category: 'IDEA_COVER',
          displayName: 'my cover.png',
          ownerId: OWNER,
          status: 'PENDING',
        }),
      });
      expect(result.upload.url).toBe('https://storage.test/upload');
      expect(result.asset.src).toBe(`/api/media/${ASSET_ID}`);
      expect(result.asset.status).toBe('PENDING');
    });

    it('#then the browser never receives a storage credential', async () => {
      const { service } = make();

      const result = await service.createUpload(OWNER, {
        byteSize: 2048,
        contentType: 'image/png',
      });

      expect(JSON.stringify(result)).not.toMatch(/service_role|apikey|secret/i);
    });
  });

  describe('#given the provider refuses to issue a target', () => {
    it('#then it becomes a 503 without the provider message', async () => {
      const { service } = make({
        storage: {
          createUpload: jest
            .fn()
            .mockRejectedValue(
              new MediaStorageError('MEDIA_STORAGE_UNAVAILABLE', 'bucket inverge-media rejected'),
            ),
        },
      });

      const error = await service
        .createUpload(OWNER, { byteSize: 1024, contentType: 'image/png' })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(JSON.stringify((error as HttpException).getResponse())).not.toContain('inverge-media');
    });
  });
});

describe('MediaAssetsService.completeUpload', () => {
  describe('#given an asset belonging to another user', () => {
    it('#then it is a 404, not a 403', async () => {
      const { service, prisma } = make();
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset({ ownerId: OTHER })));

      await expect(service.completeUpload(OWNER, ASSET_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('#given an asset that is already READY', () => {
    it('#then the call is idempotent and storage is not consulted again', async () => {
      const { service, prisma, storage } = make();
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset()));

      const result = await service.completeUpload(OWNER, ASSET_ID);

      expect(result.status).toBe('READY');
      expect(storage.stat).not.toHaveBeenCalled();
      expect(storage.readHead).not.toHaveBeenCalled();
    });
  });

  describe('#given the bytes never arrived', () => {
    it('#then the asset stays PENDING and the client can retry', async () => {
      const { service, prisma, storage } = make();
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset({ status: 'PENDING' })));
      (storage.stat as jest.Mock).mockResolvedValue(null);

      await expect(service.completeUpload(OWNER, ASSET_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.mediaAsset.update).not.toHaveBeenCalled();
    });
  });

  describe('#given an empty object', () => {
    it('#then it is rejected and the object is removed', async () => {
      const { service, prisma, storage } = make();
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset({ status: 'PENDING' })));
      (storage.stat as jest.Mock).mockResolvedValue({ byteSize: 0, contentType: 'image/png' });

      await expect(service.completeUpload(OWNER, ASSET_ID)).rejects.toThrow(HttpException);
      expect(storage.remove).toHaveBeenCalledWith(OBJECT_KEY);
      expect(prisma.mediaAsset.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED' }) }),
      );
    });
  });

  describe('#given an object larger than the configured limit', () => {
    it('#then it is rejected with 413 and removed', async () => {
      const { service, prisma, storage } = make();
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset({ status: 'PENDING' })));
      (storage.stat as jest.Mock).mockResolvedValue({
        byteSize: 9 * 1024 * 1024,
        contentType: 'image/png',
      });

      const error = await service
        .completeUpload(OWNER, ASSET_ID)
        .catch((caught: unknown) => caught);

      expect((error as HttpException).getStatus()).toBe(413);
      expect(storage.remove).toHaveBeenCalledWith(OBJECT_KEY);
    });
  });

  describe('#given bytes that are not an image', () => {
    it('#then it is rejected with 415 and the object is removed', async () => {
      const { service, prisma, storage } = make();
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset({ status: 'PENDING' })));
      (storage.readHead as jest.Mock).mockResolvedValue({
        byteSize: 20,
        bytes: new TextEncoder().encode('<svg onload="alert(1)">'),
        contentType: 'image/png',
      });

      const error = await service
        .completeUpload(OWNER, ASSET_ID)
        .catch((caught: unknown) => caught);

      expect((error as HttpException).getStatus()).toBe(415);
      expect(storage.remove).toHaveBeenCalledWith(OBJECT_KEY);
    });
  });

  describe('#given a declared type that does not match the bytes', () => {
    it('#then it is rejected, because the key extension would lie', async () => {
      const { service, prisma, storage } = make();
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset({ mimeType: 'image/jpeg', status: 'PENDING' })));

      const error = await service
        .completeUpload(OWNER, ASSET_ID)
        .catch((caught: unknown) => caught);

      expect((error as HttpException).getStatus()).toBe(415);
      expect((error as HttpException).getResponse()).toEqual(
        expect.objectContaining({ code: 'MEDIA_TYPE_MISMATCH' }),
      );
      expect(storage.remove).toHaveBeenCalled();
    });
  });

  describe('#given bytes the provider recorded as a different type', () => {
    it('#then it is rejected', async () => {
      const { service, prisma, storage } = make();
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset({ status: 'PENDING' })));
      (storage.stat as jest.Mock).mockResolvedValue({
        byteSize: 1024,
        contentType: 'text/html',
      });

      const error = await service
        .completeUpload(OWNER, ASSET_ID)
        .catch((caught: unknown) => caught);

      expect((error as HttpException).getStatus()).toBe(415);
    });
  });

  describe('#given a verified image', () => {
    it('#then the row records the real size and intrinsic dimensions', async () => {
      const { service, prisma } = make();
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset({ status: 'PENDING' })));
      (prisma.mediaAsset.update as jest.Mock).mockImplementation(
        ({ data, where }: { data: object; where: { id: string } }) =>
          Promise.resolve({ ...asset({ status: 'PENDING' }), ...data, id: where.id }),
      );

      const result = await service.completeUpload(OWNER, ASSET_ID);

      expect(prisma.mediaAsset.update).toHaveBeenCalledWith({
        data: {
          byteSize: 1024,
          height: 50,
          mimeType: 'image/png',
          status: 'READY',
          width: 100,
        },
        where: { id: ASSET_ID },
      });
      expect(result.status).toBe('READY');
      expect(result.width).toBe(100);
      expect(result.previewUrl).toBe('https://storage.test/signed');
    });
  });

  describe('#given a deleted asset', () => {
    it('#then completion is refused', async () => {
      const { service, prisma } = make();
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset({ status: 'DELETED' })));

      await expect(service.completeUpload(OWNER, ASSET_ID)).rejects.toThrow(ConflictException);
    });
  });
});

describe('MediaAssetsService.readUrl', () => {
  describe('#given a draft idea and an anonymous reader', () => {
    it('#then the asset is invisible', async () => {
      const { service, prisma } = make();
      prisma.mediaAsset.findUnique.mockResolvedValue(
        asset({ idea: { status: 'DRAFT' }, ideaId: 'idea-1' }),
      );

      await expect(service.readUrl(undefined, ASSET_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('#given a published idea and an anonymous reader', () => {
    it('#then a short-lived URL is issued', async () => {
      const { service, prisma } = make();
      prisma.mediaAsset.findUnique.mockResolvedValue(
        asset({ idea: { status: 'VALIDATING' }, ideaId: 'idea-1' }),
      );

      await expect(service.readUrl(undefined, ASSET_ID)).resolves.toEqual({
        expiresAt: '2026-10-30T11:00:00.000Z',
        public: true,
        url: 'https://storage.test/signed',
      });
    });
  });

  describe('#given an unbound upload and an anonymous reader', () => {
    it('#then it is invisible even though it is READY', async () => {
      const { service, prisma } = make();
      prisma.mediaAsset.findUnique.mockResolvedValue(asset());

      await expect(service.readUrl(undefined, ASSET_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('#given a draft idea and its owner', () => {
    it('#then the owner can preview it', async () => {
      const { service, prisma } = make();
      prisma.mediaAsset.findUnique.mockResolvedValue(
        asset({ idea: { status: 'DRAFT' }, ideaId: 'idea-1' }),
      );

      await expect(
        service.readUrl({ id: OWNER, role: 'USER' }, ASSET_ID),
      ).resolves.toBeDefined();
    });
  });

  describe('#given a campaign that is still a draft', () => {
    it('#then the public cannot read its media', async () => {
      const { service, prisma } = make();
      prisma.mediaAsset.findUnique.mockResolvedValue(
        asset({ campaign: { status: 'DRAFT' }, campaignId: 'campaign-1' }),
      );

      await expect(service.readUrl(undefined, ASSET_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('#given an active campaign', () => {
    it('#then the public can read its media', async () => {
      const { service, prisma } = make();
      prisma.mediaAsset.findUnique.mockResolvedValue(
        asset({ campaign: { status: 'ACTIVE' }, campaignId: 'campaign-1' }),
      );

      await expect(service.readUrl(undefined, ASSET_ID)).resolves.toBeDefined();
    });
  });

  describe('#given an asset whose bytes are not verified', () => {
    it('#then no URL is issued, even to the owner', async () => {
      const { service, prisma } = make();
      prisma.mediaAsset.findUnique.mockResolvedValue(asset({ status: 'PENDING' }));

      await expect(
        service.readUrl({ id: OWNER, role: 'USER' }, ASSET_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

describe('MediaAssetsService.remove', () => {
  describe('#given the owner', () => {
    it('#then the object and the row are both retired', async () => {
      const { service, prisma, storage } = make();
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset()));

      await expect(service.remove(OWNER, ASSET_ID)).resolves.toEqual({
        deleted: true,
        id: ASSET_ID,
      });
      expect(storage.remove).toHaveBeenCalledWith(OBJECT_KEY);
      expect(prisma.mediaAsset.update).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'DELETED' }),
        where: { id: ASSET_ID },
      });
    });
  });

  describe('#given a second deletion request', () => {
    it('#then it succeeds without touching storage again', async () => {
      const { service, prisma, storage } = make();
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset({ status: 'DELETED' })));

      await expect(service.remove(OWNER, ASSET_ID)).resolves.toEqual({
        deleted: true,
        id: ASSET_ID,
      });
      expect(storage.remove).not.toHaveBeenCalled();
    });
  });

  describe('#given another user', () => {
    it('#then the asset is a 404 and nothing is deleted', async () => {
      const { service, prisma, storage } = make();
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset({ ownerId: OTHER })));

      await expect(service.remove(OWNER, ASSET_ID)).rejects.toThrow(NotFoundException);
      expect(storage.remove).not.toHaveBeenCalled();
    });
  });

  describe('#given the provider is unreachable', () => {
    it('#then the asset is still retired from every surface', async () => {
      const { service, prisma } = make({
        storage: {
          remove: jest
            .fn()
            .mockRejectedValue(new MediaStorageError('MEDIA_STORAGE_UNAVAILABLE', 'down')),
        },
      });
      prisma.mediaAsset.findFirst.mockImplementation(findFirstReturning(asset()));

      await expect(service.remove(OWNER, ASSET_ID)).resolves.toEqual({
        deleted: true,
        id: ASSET_ID,
      });
      expect(prisma.mediaAsset.update).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'DELETED' }),
        where: { id: ASSET_ID },
      });
    });
  });
});

describe('MediaAssetsService.assertAttachable', () => {
  function withAssets(assets: Array<{ id: string; ownerId: string; status: string }>) {
    const context = make();
    context.prisma.mediaAsset.findMany.mockResolvedValue(assets);
    return context;
  }

  describe('#given no references', () => {
    it('#then nothing is queried', async () => {
      const { service, prisma } = make();

      await service.assertAttachable(OWNER, [undefined, null, '']);

      expect(prisma.mediaAsset.findMany).not.toHaveBeenCalled();
    });
  });

  describe('#given an external https reference', () => {
    it('#then it is accepted without a database read', async () => {
      const { service, prisma } = make();

      await service.assertAttachable(OWNER, ['https://example.com/photo.jpg']);

      expect(prisma.mediaAsset.findMany).not.toHaveBeenCalled();
    });
  });

  describe('#given a reference that is not media at all', () => {
    it.each([['javascript:alert(1)'], ['data:image/png;base64,AA'], ['//example.com/a.jpg'], ['not a url']])(
      '#when the value is %s #then it is a 400',
      async (value) => {
        const { service } = make();

        await expect(service.assertAttachable(OWNER, [value])).rejects.toThrow(
          BadRequestException,
        );
      },
    );
  });

  describe('#given another user\u2019s asset', () => {
    it('#then it is a 403 and cannot be attached', async () => {
      const { service } = withAssets([
        { id: ASSET_ID, ownerId: OTHER, status: 'READY' },
      ]);

      await expect(
        service.assertAttachable(OWNER, [`/api/media/${ASSET_ID}`]),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('#given an asset that is still uploading', () => {
    it('#then it is a 400', async () => {
      const { service } = withAssets([
        { id: ASSET_ID, ownerId: OWNER, status: 'PENDING' },
      ]);

      await expect(
        service.assertAttachable(OWNER, [`/api/media/${ASSET_ID}`]),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('#given an asset id that does not exist', () => {
    it('#then it is a 400', async () => {
      const { service } = withAssets([]);

      await expect(
        service.assertAttachable(OWNER, [`/api/media/${ASSET_ID}`]),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('#given the owner\u2019s verified asset', () => {
    it('#then it is accepted once, however many times it appears', async () => {
      const { service, prisma } = withAssets([
        { id: ASSET_ID, ownerId: OWNER, status: 'READY' },
      ]);

      await expect(
        service.assertAttachable(OWNER, [
          `/api/media/${ASSET_ID}`,
          `  /api/media/${ASSET_ID}  `,
          'https://example.com/photo.jpg',
        ]),
      ).resolves.toBeUndefined();
      expect(prisma.mediaAsset.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: [ASSET_ID] } } }),
      );
    });
  });
});

describe('MediaAssetsService.bindToIdea / bindToCampaign', () => {
  it('#given a media reference #then the asset is bound to the record it was attached to', async () => {
    const { service, prisma } = make();

    await service.bindToIdea(OWNER, 'idea-1', [`/api/media/${ASSET_ID}`]);
    await service.bindToCampaign(OWNER, 'campaign-1', [`/api/media/${ASSET_ID}`]);

    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      data: { ideaId: 'idea-1' },
      where: { id: { in: [ASSET_ID] }, ownerId: OWNER },
    });
    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      data: { campaignId: 'campaign-1' },
      where: { id: { in: [ASSET_ID] }, ownerId: OWNER },
    });
  });

  it('#given only external references #then no row is touched', async () => {
    const { service, prisma } = make();

    await service.bindToIdea(OWNER, 'idea-1', ['https://example.com/photo.jpg']);

    expect(prisma.mediaAsset.updateMany).not.toHaveBeenCalled();
  });
});

describe('MediaAssetsService.bindToCreatorProfile', () => {
  it('#given an uploaded avatar #then the previous picture is released and the new one bound', async () => {
    const { service, prisma } = make();

    await service.bindToCreatorProfile(OWNER, `/api/media/${ASSET_ID}`);

    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      data: { creatorProfileUserId: null },
      where: { creatorProfileUserId: OWNER, id: { not: ASSET_ID } },
    });
    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      data: { creatorProfileUserId: OWNER },
      where: { id: ASSET_ID, ownerId: OWNER },
    });
  });

  it('#given a cleared avatar #then every picture the profile held is released', async () => {
    const { service, prisma } = make();

    await service.bindToCreatorProfile(OWNER, null);

    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      data: { creatorProfileUserId: null },
      where: { creatorProfileUserId: OWNER },
    });
  });

  it('#given an external avatar #then the old picture is released without binding a row', async () => {
    const { service, prisma } = make();

    await service.bindToCreatorProfile(OWNER, 'https://lh3.googleusercontent.com/a/example=s96-c');

    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      data: { creatorProfileUserId: null },
      where: { creatorProfileUserId: OWNER },
    });
  });
});
describe('MediaAssetsService.purgeAbandoned', () => {
  it('#given a stale pending upload #then the object and the row are retired', async () => {
    const { service, prisma, storage } = make();
    prisma.mediaAsset.findMany.mockResolvedValue([
      { id: ASSET_ID, objectKey: OBJECT_KEY },
    ]);

    await expect(service.purgeAbandoned(24)).resolves.toEqual({
      examined: 1,
      removed: 1,
    });
    expect(storage.remove).toHaveBeenCalledWith(OBJECT_KEY);
  });

  it('#given a provider failure #then the row is kept for the next pass', async () => {
    const { service, prisma } = make({
      storage: {
        remove: jest
          .fn()
          .mockRejectedValue(new MediaStorageError('MEDIA_STORAGE_UNAVAILABLE', 'down')),
      },
    });
    prisma.mediaAsset.findMany.mockResolvedValue([
      { id: ASSET_ID, objectKey: OBJECT_KEY },
    ]);

    await expect(service.purgeAbandoned(24)).resolves.toEqual({
      examined: 1,
      removed: 0,
    });
    expect(prisma.mediaAsset.update).not.toHaveBeenCalled();
  });
});
