import { describe, expect, it } from 'vitest';
import {
  AVATAR_LIMITS,
  avatarTarget,
  fileSignatureInput,
  fileUrlExpiry,
  FILE_URL_MAX_AHEAD_S,
  imageInfo,
  serverIconClearSchema,
  uploadBeginSchema,
} from '../src/index.js';

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

const PNG = bytes([0x89], 'PNG\r\n\x1a\n', be32(13), 'IHDR', be32(300), be32(200), [8, 6, 0, 0, 0]);
const GIF = bytes('GIF89a', le16(256), le16(128), [0xf7, 0, 0]);
const WEBP_LOSSY = bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 ', [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], le16(256), le16(255), [0, 0]);
// VP8L packs (width-1) and (height-1) in 14 bits each, little-endian bits.
const vp8l = (w: number, h: number) => {
  const v = (w - 1) | ((h - 1) << 14);
  return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
};
const WEBP_LOSSLESS = bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8L', [0, 0, 0, 0], [0x2f], vp8l(256, 100), [0, 0, 0, 0, 0]);
const WEBP_EXTENDED = bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0], [0x02, 0, 0, 0], le24(255), le24(511), [0, 0]);
const JPEG = bytes(
  [0xff, 0xd8],
  [0xff, 0xe0, 0x00, 0x10],
  'JFIF\0',
  [1, 1, 0, 0, 1, 0, 1, 0, 0],
  [0xff, 0xc4, 0x00, 0x04, 0, 0],
  [0xff, 0xc0, 0x00, 0x11, 8],
  [0x00, 0x96], // height 150
  [0x01, 0x2c], // width 300
  [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
);

describe('imageInfo', () => {
  it('reads PNG, GIF, the three WebP kinds and JPEG from their bytes', () => {
    expect(imageInfo(PNG)).toEqual({ mime: 'image/png', width: 300, height: 200 });
    expect(imageInfo(GIF)).toEqual({ mime: 'image/gif', width: 256, height: 128 });
    expect(imageInfo(WEBP_LOSSY)).toEqual({ mime: 'image/webp', width: 256, height: 255 });
    expect(imageInfo(WEBP_LOSSLESS)).toEqual({ mime: 'image/webp', width: 256, height: 100 });
    expect(imageInfo(WEBP_EXTENDED)).toEqual({ mime: 'image/webp', width: 256, height: 512 });
    expect(imageInfo(JPEG)).toEqual({ mime: 'image/jpeg', width: 300, height: 150 });
  });

  it('refuses other files, truncated headers and zero sides', () => {
    expect(imageInfo(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(imageInfo(new Uint8Array(0))).toBeNull();
    expect(imageInfo(PNG.slice(0, 20))).toBeNull();
    expect(imageInfo(WEBP_LOSSY.slice(0, 26))).toBeNull();
    expect(imageInfo(JPEG.slice(0, 12))).toBeNull();
    expect(imageInfo(bytes('GIF89a', le16(0), le16(10), [0, 0, 0]))).toBeNull();
    // A WebP whose lossy frame lacks the start code.
    const broken = WEBP_LOSSY.slice();
    broken[23] = 0;
    expect(imageInfo(broken)).toBeNull();
  });
});

describe('signed photo URLs', () => {
  it('signs the frozen label, the target, the session and the expiry, one per line', () => {
    const hash = 'a'.repeat(64);
    expect(avatarTarget(hash)).toBe(`avatar:${hash}`);
    expect(fileSignatureInput(avatarTarget(hash), 'sid1', 1_800_000_600)).toBe(`ghostlink-file-v1\navatar:${hash}\nsid1\n1800000600`);
  });

  it('expires at the end of the next 10-minute window, never beyond what the server accepts', () => {
    expect(fileUrlExpiry(1_800_000_000_000)).toBe(1_800_000_600);
    expect(fileUrlExpiry(1_800_000_001_000)).toBe(1_800_001_200);
    for (const now of [0, 1, 599_999, 600_000, 1_234_567_890_123]) {
      const ahead = fileUrlExpiry(now) - now / 1000;
      expect(ahead).toBeGreaterThan(600 - 1);
      expect(ahead).toBeLessThanOrEqual(FILE_URL_MAX_AHEAD_S);
    }
  });
});

describe('uploadBeginSchema', () => {
  it('takes an avatar up to 2 MB with its hash, nothing else', () => {
    const ok = { purpose: 'avatar', size: AVATAR_LIMITS.maxBytes, sha256: 'f'.repeat(64) };
    expect(uploadBeginSchema.parse(ok)).toEqual(ok);
    expect(() => uploadBeginSchema.parse({ ...ok, size: AVATAR_LIMITS.maxBytes + 1 })).toThrow();
    expect(() => uploadBeginSchema.parse({ ...ok, purpose: 'attachment' })).toThrow();
    expect(() => uploadBeginSchema.parse({ ...ok, sha256: 'F'.repeat(64) })).toThrow();
    expect(() => uploadBeginSchema.parse({ ...ok, extra: 1 })).toThrow();
  });

  it('takes a server icon with the same limits (spec 2026-10-01-icone-do-servidor)', () => {
    const icon = { purpose: 'icon', size: AVATAR_LIMITS.maxBytes, sha256: 'a'.repeat(64) };
    expect(uploadBeginSchema.parse(icon)).toEqual(icon);
    expect(() => uploadBeginSchema.parse({ ...icon, size: AVATAR_LIMITS.maxBytes + 1 })).toThrow();
  });
});

describe('serverIconClearSchema', () => {
  it('takes an empty object only', () => {
    expect(serverIconClearSchema.parse({})).toEqual({});
    expect(() => serverIconClearSchema.parse({ icon: null })).toThrow();
  });
});
