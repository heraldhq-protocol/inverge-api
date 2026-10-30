/**
 * Image sniffing and intrinsic dimensions.
 *
 * The browser's `File.type` is a claim, not evidence: it comes from the
 * operating system's file-extension mapping and a caller can set it to anything.
 * This module reads the bytes instead. A file is only accepted when its magic
 * bytes identify a format this service is prepared to serve, and the same read
 * yields the intrinsic width and height so a page can reserve the right box and
 * not shift when the image arrives.
 *
 * Pure and dependency-free so it is exhaustively unit-tested without a storage
 * provider, a network call or a filesystem.
 *
 * Deliberately unsupported: SVG (an XML document that can carry script, and this
 * service has no sanitiser), TIFF, BMP, AVIF and HEIC (no browser support policy
 * is defined for them yet). A format that is not detected is rejected, not
 * guessed from its extension.
 */

export type DetectedImageType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif";

export type DetectedImage = {
  mimeType: DetectedImageType;
  /** Intrinsic pixel width, or null when the header could not be read. */
  width: number | null;
  /** Intrinsic pixel height, or null when the header could not be read. */
  height: number | null;
};

/** The canonical extension for a detected type. Used to build object keys. */
export const IMAGE_EXTENSIONS: Readonly<Record<DetectedImageType, string>> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * How many leading bytes a verification read should request.
 *
 * 64 KiB is comfortably past the metadata segments a normal camera JPEG carries
 * before its frame header, and it is one small ranged request rather than a full
 * download of a multi-megabyte image.
 */
export const IMAGE_SNIFF_BYTES = 64 * 1024;

function byteAt(head: Uint8Array, index: number): number {
  return index >= 0 && index < head.length ? (head[index] as number) : -1;
}

function ascii(head: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(byteAt(head, offset + index));
  }
  return text;
}

function u16be(head: Uint8Array, offset: number): number {
  return (byteAt(head, offset) << 8) | byteAt(head, offset + 1);
}

function u16le(head: Uint8Array, offset: number): number {
  return byteAt(head, offset) | (byteAt(head, offset + 1) << 8);
}

function u24le(head: Uint8Array, offset: number): number {
  return (
    byteAt(head, offset) |
    (byteAt(head, offset + 1) << 8) |
    (byteAt(head, offset + 2) << 16)
  );
}

function u32be(head: Uint8Array, offset: number): number {
  return (
    ((byteAt(head, offset) << 24) >>> 0) +
    (byteAt(head, offset + 1) << 16) +
    (byteAt(head, offset + 2) << 8) +
    byteAt(head, offset + 3)
  );
}

function u32le(head: Uint8Array, offset: number): number {
  return (
    byteAt(head, offset) +
    (byteAt(head, offset + 1) << 8) +
    (byteAt(head, offset + 2) << 16) +
    ((byteAt(head, offset + 3) << 24) >>> 0)
  );
}

/** A dimension of 0 is not a usable image, so it is reported as unknown. */
function dimension(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function detectPng(head: Uint8Array): DetectedImage | null {
  if (head.length < 24) return null;
  if (PNG_SIGNATURE.some((byte, index) => byteAt(head, index) !== byte)) {
    return null;
  }
  // The first chunk of a valid PNG must be IHDR, whose payload starts at 16.
  if (ascii(head, 12, 4) !== "IHDR") return null;

  return {
    height: dimension(u32be(head, 20)),
    mimeType: "image/png",
    width: dimension(u32be(head, 16)),
  };
}

function detectGif(head: Uint8Array): DetectedImage | null {
  if (head.length < 10) return null;
  const header = ascii(head, 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return null;

  return {
    height: dimension(u16le(head, 8)),
    mimeType: "image/gif",
    width: dimension(u16le(head, 6)),
  };
}

/** Segment markers that carry no length field and are skipped by the scanner. */
const JPEG_STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);

/**
 * Start-of-frame markers. 0xC4 (Huffman tables), 0xC8 (reserved) and 0xCC
 * (arithmetic coding) share the 0xC? range but are not frame headers, so a
 * scanner that treats every 0xC? as one reads a nonsense width.
 */
function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function detectJpeg(head: Uint8Array): DetectedImage | null {
  if (head.length < 4) return null;
  if (byteAt(head, 0) !== 0xff || byteAt(head, 1) !== 0xd8) return null;

  let offset = 2;
  while (offset + 3 < head.length) {
    if (byteAt(head, offset) !== 0xff) {
      // A marker must start immediately; anything else means the header is not
      // where we expect it and the dimensions are not safely readable.
      return { height: null, mimeType: "image/jpeg", width: null };
    }

    // Fill bytes: any number of 0xFF may precede the marker code.
    let markerOffset = offset;
    while (byteAt(head, markerOffset + 1) === 0xff) markerOffset += 1;

    const marker = byteAt(head, markerOffset + 1);
    if (marker < 0) break;

    if (isStartOfFrame(marker)) {
      if (markerOffset + 8 >= head.length) break;
      return {
        height: dimension(u16be(head, markerOffset + 5)),
        mimeType: "image/jpeg",
        width: dimension(u16be(head, markerOffset + 7)),
      };
    }

    if (JPEG_STANDALONE.has(marker)) {
      offset = markerOffset + 2;
      continue;
    }

    const segmentLength = u16be(head, markerOffset + 2);
    // A zero or one-byte length would not advance the scan; stop rather than
    // spin on a malformed file.
    if (segmentLength < 2) break;
    offset = markerOffset + 2 + segmentLength;
  }

  // The signature is valid, so the file is a JPEG; only the size is unknown.
  return { height: null, mimeType: "image/jpeg", width: null };
}

function detectWebp(head: Uint8Array): DetectedImage | null {
  if (head.length < 30) return null;
  if (ascii(head, 0, 4) !== "RIFF" || ascii(head, 8, 4) !== "WEBP") return null;

  const chunk = ascii(head, 12, 4);

  if (chunk === "VP8X") {
    return {
      height: dimension(u24le(head, 27) + 1),
      mimeType: "image/webp",
      width: dimension(u24le(head, 24) + 1),
    };
  }

  if (chunk === "VP8L") {
    if (byteAt(head, 20) !== 0x2f) {
      return { height: null, mimeType: "image/webp", width: null };
    }
    const bits = u32le(head, 21);
    return {
      height: dimension(((bits >>> 14) & 0x3fff) + 1),
      mimeType: "image/webp",
      width: dimension((bits & 0x3fff) + 1),
    };
  }

  if (chunk === "VP8 ") {
    const startCode =
      byteAt(head, 23) === 0x9d &&
      byteAt(head, 24) === 0x01 &&
      byteAt(head, 25) === 0x2a;
    if (!startCode) {
      return { height: null, mimeType: "image/webp", width: null };
    }
    return {
      height: dimension(u16le(head, 28) & 0x3fff),
      mimeType: "image/webp",
      width: dimension(u16le(head, 26) & 0x3fff),
    };
  }

  return { height: null, mimeType: "image/webp", width: null };
}

/**
 * The detected format and, where the header allows, its intrinsic size.
 *
 * Returns `null` for anything that is not an image this service serves. Callers
 * must treat `null` as a rejection, including for a well-known type the
 * allowlist does not include yet: detection and policy are separate decisions.
 */
export function detectImage(head: Uint8Array): DetectedImage | null {
  if (head.length < 4) return null;
  return detectPng(head) ?? detectJpeg(head) ?? detectWebp(head) ?? detectGif(head);
}
