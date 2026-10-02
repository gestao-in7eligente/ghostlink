// Profile photos (spec 2026-10-01-foto-de-perfil-design.md): one photo per person, sent to
// every server that announces `avatars` and addressed everywhere by its SHA-256.
import { z } from 'zod';
import { CRYPTO_LABELS } from './constants.js';

export const AVATAR_LIMITS = {
  /** The stored photo, as uploaded and served (spec §1). */
  maxBytes: 2 * 1024 * 1024,
  /** Sides the server accepts, in pixels. */
  minSide: 16,
  maxSide: 512,
  /** What the app produces after cropping. */
  outputSide: 256,
  /** The file a person picks, before cropping. */
  inputMaxBytes: 10 * 1024 * 1024,
  /** Frames kept from an animated image. */
  maxFrames: 300,
  /** Photo changes per person per minute (server). */
  changesPerMinute: 5,
} as const;

/** The `features` flag of a server that takes profile photos. */
export const FEATURE_AVATARS = 'avatars';

/** The `features` flag of a server that takes an icon (spec 2026-10-01-icone-do-servidor). */
export const FEATURE_SERVER_ICON = 'serverIcon';

/** A photo's address: SHA-256 of its bytes, lower-case hex. */
export const AVATAR_HASH = /^[0-9a-f]{64}$/;
export const avatarHashSchema = z.string().regex(AVATAR_HASH);

/** `upload.begin` for a profile photo (spec §4); upload.ts joins every purpose in `uploadBeginSchema`. */
export const avatarUploadBeginSchema = z.strictObject({
  purpose: z.literal('avatar'),
  size: z.number().int().min(1).max(AVATAR_LIMITS.maxBytes),
  sha256: avatarHashSchema,
});
/**
 * `upload.begin` for the server's icon (MANAGE_SERVER, spec 2026-10-01-icone-do-servidor): an
 * image with the same limits as a photo.
 */
export const iconUploadBeginSchema = z.strictObject({
  purpose: z.literal('icon'),
  size: z.number().int().min(1).max(AVATAR_LIMITS.maxBytes),
  sha256: avatarHashSchema,
});
/** The body of a successful avatar `POST /upload`. */
export interface AvatarUploadResult {
  avatar: string;
}

/** The body of a successful icon `POST /upload`: the server's icon is now this hash. */
export interface IconUploadResult {
  icon: string;
}

/** `avatar.clear`: back to initials. */
export const avatarClearSchema = z.strictObject({});

/** `server.iconClear` (MANAGE_SERVER): the server goes back to its initials. */
export const serverIconClearSchema = z.strictObject({});

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface ImageInfo {
  mime: ImageMime;
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const ascii = (b: Uint8Array, i: number, s: string) => [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));

function png(b: Uint8Array): ImageInfo | null {
  if (b.length < 24 || !ascii(b, 12, 'IHDR')) return null;
  return { mime: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
}

function gif(b: Uint8Array): ImageInfo | null {
  if (b.length < 10) return null;
  return { mime: 'image/gif', width: u16le(b, 6), height: u16le(b, 8) };
}

function webp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30) return null;
  if (ascii(b, 12, 'VP8 ')) {
    // Lossy: the key frame's start code, then 14-bit width and height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { mime: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return null;
    const [b0, b1, b2, b3] = [b[21]!, b[22]!, b[23]!, b[24]!];
    return { mime: 'image/webp', width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (ascii(b, 12, 'VP8X')) return { mime: 'image/webp', width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  return null;
}

function jpeg(b: Uint8Array): ImageInfo | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2; // markers without a length
      continue;
    }
    // SOF0–SOF15 carry the size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mime: 'image/jpeg', width: u16be(b, i + 7), height: u16be(b, i + 5) };
    }
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

/**
 * The type and size of an image, read from its bytes alone (never a name or a claimed type).
 * null for anything else, a truncated header, or a zero side.
 */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const b = bytes;
  let info: ImageInfo | null = null;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n')) info = png(b);
  else if (b.length >= 6 && (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) info = gif(b);
  else if (b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) info = webp(b);
  else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) info = jpeg(b);
  return info && info.width > 0 && info.height > 0 ? info : null;
}

/** The signed-URL target of a photo (main spec §7). */
export function avatarTarget(hash: string): string {
  return `avatar:${hash}`;
}

/** The exact text both sides HMAC with the session's fileToken (main spec §7). */
export function fileSignatureInput(target: string, sessionId: string, expUnix: number): string {
  return `${CRYPTO_LABELS.fileHmac}\n${target}\n${sessionId}\n${expUnix}`;
}

/** URLs last until the end of the next 10-minute window, so they stay stable and cacheable (main spec §7). */
export function fileUrlExpiry(serverNowMs: number): number {
  return Math.ceil(serverNowMs / 1000 / 600) * 600 + 600;
}

/** The server refuses an expiry further ahead than this (main spec §7). */
export const FILE_URL_MAX_AHEAD_S = 20 * 60;
