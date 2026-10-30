import {
  IMAGE_SNIFF_BYTES,
  detectImage,
  type DetectedImageType,
} from './image-metadata';

/** A PNG header with an IHDR chunk carrying the given size. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** A JPEG with one APP0 segment followed by a baseline frame header. */
function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0xff, 0xd8], 0); // SOI
  bytes.set([0xff, 0xe0, 0x00, 0x10], 2); // APP0, 16-byte segment
  const sof = 2 + 2 + 16; // marker at 2, 2 length bytes + 16-byte segment
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], sof);
  new DataView(bytes.buffer).setUint16(sof + 5, height);
  new DataView(bytes.buffer).setUint16(sof + 7, width);
  return bytes;
}

/** A canvas-made lossless WebP header. */
function webpLossless(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x24, 0x00, 0x00, 0x00], 4);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12); // VP8L
  bytes.set([0x10, 0x00, 0x00, 0x00], 16);
  bytes[20] = 0x2f;
  // 14 bits width-1, then 14 bits height-1.
  const bits = ((height - 1) << 14) | (width - 1);
  bytes.set(
    [bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff],
    21,
  );
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  new DataView(bytes.buffer).setUint16(6, width, true);
  new DataView(bytes.buffer).setUint16(8, height, true);
  return bytes;
}

describe('detectImage', () => {
  describe('#given a supported image', () => {
    it.each<[string, () => Uint8Array, DetectedImageType, number, number]>([
      ['PNG', () => png(1920, 1080), 'image/png', 1920, 1080],
      ['JPEG', () => jpeg(800, 600), 'image/jpeg', 800, 600],
      ['lossless WebP', () => webpLossless(640, 480), 'image/webp', 640, 480],
      ['GIF', () => gif(32, 24), 'image/gif', 32, 24],
    ])('#when the head is %s #then the type and size are read', (_label, make, type, width, height) => {
      const detected = detectImage(make());

      expect(detected).toEqual({ height, mimeType: type, width });
    });
  });

  describe('#given something that is not an image', () => {
    it('#when the bytes are a PDF #then nothing is detected', () => {
      const bytes = new TextEncoder().encode('%PDF-1.7\n');

      expect(detectImage(bytes)).toBeNull();
    });

    it('#when the bytes are SVG #then nothing is detected', () => {
      const bytes = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      );

      expect(detectImage(bytes)).toBeNull();
    });

    it('#when the bytes are HTML #then nothing is detected', () => {
      const bytes = new TextEncoder().encode('<!doctype html><html></html>');

      expect(detectImage(bytes)).toBeNull();
    });

    it('#when the file is truncated #then nothing is invented', () => {
      expect(detectImage(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    });

    it('#when the file is empty #then nothing is detected', () => {
      expect(detectImage(new Uint8Array())).toBeNull();
    });
  });

  describe('#given a PNG whose IHDR is not first', () => {
    it('#then the signature alone is not enough', () => {
      const bytes = png(10, 10);
      bytes.set([0x49, 0x44, 0x41, 0x54], 12); // "IDAT"

      expect(detectImage(bytes)).toBeNull();
    });
  });

  describe('#given a JPEG with no frame header in the sampled window', () => {
    it('#then it is still a JPEG, with unknown dimensions', () => {
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);

      expect(detectImage(bytes)).toEqual({
        height: null,
        mimeType: 'image/jpeg',
        width: null,
      });
    });
  });

  describe('#given a JPEG with 0xC4 in the scan', () => {
    it('#then Huffman tables are not mistaken for a frame header', () => {
      const bytes = new Uint8Array(30);
      bytes.set([0xff, 0xd8], 0);
      // A DHT segment (0xC4) carrying plausible-looking width/height bytes.
      bytes.set([0xff, 0xc4, 0x00, 0x06, 0x08, 0x02, 0x58, 0x03, 0x20], 2);

      expect(detectImage(bytes)).toEqual({
        height: null,
        mimeType: 'image/jpeg',
        width: null,
      });
    });
  });

  describe('#given a WebP chunk that is not a known frame', () => {
    it('#then the type is reported without dimensions', () => {
      const bytes = webpLossless(10, 10);
      bytes.set([0x41, 0x4c, 0x50, 0x48], 12); // "ALPH"

      expect(detectImage(bytes)).toEqual({
        height: null,
        mimeType: 'image/webp',
        width: null,
      });
    });
  });
});

describe('IMAGE_SNIFF_BYTES', () => {
  it('#given the verification window #then it is a small ranged read, not a download', () => {
    expect(IMAGE_SNIFF_BYTES).toBeGreaterThanOrEqual(24);
    expect(IMAGE_SNIFF_BYTES).toBeLessThanOrEqual(256 * 1024);
  });
});
