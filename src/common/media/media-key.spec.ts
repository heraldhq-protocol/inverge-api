import {
  assetIdFromMediaPath,
  buildObjectKey,
  isMediaPath,
  mediaPathFor,
  normaliseDisplayName,
} from './media-key';

const ASSET_ID = 'clx0mediaasset0001abcdef';

describe('mediaPathFor', () => {
  it('#given an asset id #then the stable path is the public reference', () => {
    expect(mediaPathFor(ASSET_ID)).toBe(`/api/media/${ASSET_ID}`);
  });
});

describe('assetIdFromMediaPath', () => {
  describe('#given a reference this service minted', () => {
    it('#then the id is returned', () => {
      expect(assetIdFromMediaPath(mediaPathFor(ASSET_ID))).toBe(ASSET_ID);
    });
  });

  describe('#given a reference that is not exactly one segment', () => {
    it.each([
      ['a trailing slash', `/api/media/${ASSET_ID}/`],
      ['a query string', `/api/media/${ASSET_ID}?v=2`],
      ['a fragment', `/api/media/${ASSET_ID}#x`],
      ['an extra segment', `/api/media/${ASSET_ID}/raw`],
      ['an absolute URL', `https://inverge.africa/api/media/${ASSET_ID}`],
      ['the prefix only', '/api/media/'],
      ['a traversal attempt', `/api/media/../${ASSET_ID}`],
      ['an uppercase id', `/api/media/${ASSET_ID.toUpperCase()}`],
      ['a short id', '/api/media/abc'],
      ['a very long id', `/api/media/${'a'.repeat(41)}`],
    ])('#when the reference has %s #then it is refused', (_label, value) => {
      expect(assetIdFromMediaPath(value)).toBeNull();
    });
  });
});

describe('isMediaPath', () => {
  it('#given an external URL #then it is not a media path', () => {
    expect(isMediaPath('https://images.example.com/a.jpg')).toBe(false);
  });

  it('#given a minted reference #then it is a media path', () => {
    expect(isMediaPath(mediaPathFor(ASSET_ID))).toBe(true);
  });
});

describe('buildObjectKey', () => {
  const at = new Date('2026-03-07T10:00:00.000Z');
  const nonce = '11111111-2222-3333-4444-555555555555';

  it('#given a category and extension #then the key is derived without any user input', () => {
    expect(
      buildObjectKey({ at, category: 'CAMPAIGN_HERO', extension: 'jpg', nonce }),
    ).toBe(`media/campaign-hero/2026/03/${nonce}.jpg`);
  });

  it('#given a filename-like extension #then it cannot reach the key', () => {
    const key = buildObjectKey({
      at,
      category: 'IDEA_COVER',
      extension: '../../evil.php',
      nonce,
    });

    expect(key).toBe(`media/idea-cover/2026/03/${nonce}.evilphp`);
  });

  it('#given no nonce #then two calls never collide', () => {
    const first = buildObjectKey({ at, category: 'OTHER', extension: 'png' });
    const second = buildObjectKey({ at, category: 'OTHER', extension: 'png' });

    expect(first).not.toBe(second);
  });

  it('#given the keys it produces #then none can traverse out of the prefix', () => {
    const key = buildObjectKey({ at, category: 'REWARD', extension: 'webp', nonce });

    expect(key.startsWith('media/reward/')).toBe(true);
    expect(key).not.toContain('..');
  });
});

describe('normaliseDisplayName', () => {
  describe('#given a normal filename', () => {
    it('#then it is kept', () => {
      expect(normaliseDisplayName('My prototype photo.jpg', 'image.jpg')).toBe(
        'My prototype photo.jpg',
      );
    });
  });

  describe('#given a hostile filename', () => {
    it.each([
      ['path separators', '../../etc/passwd', 'etc passwd'],
      ['a Windows path', 'C:\\Users\\me\\photo.png', 'C Users me photo.png'],
      ['control characters', 'photo\u0000\u001b.png', 'photo .png'],
      ['reserved characters', 'a<b>c|d?e*f"g.jpg', 'a b c d e f g.jpg'],
      ['leading dots', '...photo.jpg', 'photo.jpg'],
    ])('#when the name contains %s #then it is normalised', (_label, input, expected) => {
      expect(normaliseDisplayName(input, 'image.jpg')).toBe(expected);
    });
  });

  describe('#given an empty or non-string value', () => {
    it.each([[undefined], [null], [''], ['   '], [42], ['///']])(
      '#when the value is %p #then the type fallback is used',
      (input) => {
        expect(normaliseDisplayName(input, 'image.png')).toBe('image.png');
      },
    );
  });

  describe('#given an overlong name', () => {
    it('#then it is bounded', () => {
      const name = normaliseDisplayName('a'.repeat(400), 'image.jpg');

      expect(name.length).toBe(120);
    });
  });
});
