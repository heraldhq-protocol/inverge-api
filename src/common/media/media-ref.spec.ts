import {
  collectMediaReferences,
  isAcceptableExternalMediaUrl,
  parseMediaReference,
  referencedAssetIds,
} from './media-ref';

const ASSET_ID = 'clx0mediaasset0001abcdef';

describe('isAcceptableExternalMediaUrl', () => {
  describe('#given a public https URL', () => {
    it.each([
      'https://images.example.com/a.jpg',
      'https://cdn.example.co.uk/dir/a.webp?w=1200',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://example.com:8443/a.png',
    ])('#when the value is %s #then it is accepted', (value) => {
      expect(isAcceptableExternalMediaUrl(value)).toBe(true);
    });
  });

  describe('#given a URL that is not a safe external reference', () => {
    it.each([
      ['a plain http URL', 'http://example.com/a.jpg'],
      ['a javascript URL', 'javascript:alert(1)'],
      ['a data URL', 'data:image/png;base64,AAAA'],
      ['a protocol-relative URL', '//example.com/a.jpg'],
      ['a credentialed URL', 'https://user:pass@example.com/a.jpg'],
      ['a loopback host', 'https://localhost/a.jpg'],
      ['a loopback IP', 'https://127.0.0.1/a.jpg'],
      ['an intranet host', 'https://storage/a.jpg'],
      ['a same-origin path', '/images/a.jpg'],
      ['an empty string', ''],
      ['a malformed URL', 'https://'],
    ])('#when the value is %s #then it is refused', (_label, value) => {
      expect(isAcceptableExternalMediaUrl(value)).toBe(false);
    });
  });

  describe('#given an overlong URL', () => {
    it('#then it is refused', () => {
      expect(
        isAcceptableExternalMediaUrl(`https://example.com/${'a'.repeat(2100)}`),
      ).toBe(false);
    });
  });

  describe('#given a non-string', () => {
    it('#then it is refused', () => {
      expect(isAcceptableExternalMediaUrl(null)).toBe(false);
      expect(isAcceptableExternalMediaUrl(42)).toBe(false);
    });
  });
});

describe('parseMediaReference', () => {
  it('#given an asset path #then it is an asset reference', () => {
    expect(parseMediaReference(`/api/media/${ASSET_ID}`)).toEqual({
      id: ASSET_ID,
      kind: 'asset',
    });
  });

  it('#given an external URL #then it is an external reference', () => {
    expect(parseMediaReference('https://example.com/a.jpg')).toEqual({
      kind: 'external',
      url: 'https://example.com/a.jpg',
    });
  });

  it('#given surrounding whitespace #then it is trimmed', () => {
    expect(parseMediaReference('  https://example.com/a.jpg  ')).toEqual({
      kind: 'external',
      url: 'https://example.com/a.jpg',
    });
  });

  it.each([[''], ['   '], ['ftp://example.com/a.jpg'], ['not a url']])(
    '#given %p #then nothing is parsed',
    (value) => {
      expect(parseMediaReference(value)).toBeNull();
    },
  );
});

describe('referencedAssetIds', () => {
  it('#given a mixed list #then only asset ids survive, once each', () => {
    const ids = referencedAssetIds([
      `/api/media/${ASSET_ID}`,
      `  /api/media/${ASSET_ID}  `,
      'https://example.com/a.jpg',
      null,
      undefined,
    ]);

    expect(ids).toEqual([ASSET_ID]);
  });
});

describe('collectMediaReferences', () => {
  it('#given reward-tier JSON #then nested asset references are found', () => {
    const tiers = [
      { id: 't1', imageInput: `/api/media/${ASSET_ID}`, title: 'Sticker pack' },
      { id: 't2', imageInput: 'https://example.com/a.jpg' },
    ];

    expect(collectMediaReferences(tiers)).toEqual([`/api/media/${ASSET_ID}`]);
  });

  it('#given arbitrary strings #then ordinary text is not collected', () => {
    expect(collectMediaReferences({ note: 'a photo of the prototype' })).toEqual([]);
  });

  it('#given a deeply nested document #then the walk is bounded', () => {
    let value: Record<string, unknown> = { image: `/api/media/${ASSET_ID}` };
    for (let index = 0; index < 20; index += 1) value = { nested: value };

    expect(collectMediaReferences(value)).toEqual([]);
  });
});
