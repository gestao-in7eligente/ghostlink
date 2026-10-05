// Attachments (spec 2026-10-01-anexos-design.md, main spec §7 "Arquivos"): images, video,
// audio and documents in server channels (§2) and in direct messages (§3). The type of a file
// always comes from its bytes, never from its name or a claimed type.
import { z } from 'zod';
import { imageInfo } from './avatar.js';

/** The `features` flag of a server that takes attachments (spec §2). */
export const FEATURE_ATTACHMENTS = 'attachments';

export const ATTACHMENT_KINDS = ['image', 'video', 'audio', 'file'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Bytes in one "MB" of upload_limit_mb and storage_quota_mb. */
export const MB = 1024 * 1024;

export const ATTACHMENT_LIMITS = {
  /** An image above this many pixels on a side is refused (IMAGE_TOO_LARGE). */
  maxImageSide: 8192,
  /** ...and so is one above this many pixels in all. */
  maxImagePixels: 40_000_000,
  /** A stored name, in code points, after cleanFileName (the extension is kept). */
  nameMax: 255,
  /** The longest name upload.begin accepts before cleaning. */
  nameInputMax: 1024,
  /** fileInfo reads at most this much of the start of a file. */
  sniffBytes: 1024 * 1024,
  /** server_meta.upload_limit_mb: the default and what server.update accepts (MB per file). */
  uploadLimitMb: { default: 25, min: 1, max: 2048 },
  /** server_meta.storage_quota_mb: the default and what server.update accepts (MB in all). */
  storageQuotaMb: { default: 10_240, min: 1, max: 1_048_576 },
  /** An upload no message used within this long is deleted (spec §2 "Limpeza"). */
  unusedTtlMs: 60 * 60_000,
  /** upload.begin with purpose 'attachment', per person per minute (main spec §13). */
  beginsPerMinute: 10,
} as const;

/** What a message says about one of its files (a DM entry's file adds `hash` instead of `id`, spec §3). */
export interface AttachmentMeta {
  /** Cleaned (cleanFileName): safe to show and to offer as the name to save under. */
  name: string;
  /** Bytes. */
  size: number;
  kind: AttachmentKind;
  /** From the bytes (fileInfo); `application/octet-stream` when unknown. */
  mime: string;
  /** Images only, in pixels. */
  width?: number;
  height?: number;
}

/** A file of a channel message (spec §2): `Message.attachments[]`. */
export interface Attachment extends AttachmentMeta {
  /** The file's id: `GET /files/<id>` with a URL signed for that id (fileTarget). */
  id: string;
}

const side = z.number().int().min(1).max(65_535);

/** Lenient (client side): unknown keys dropped, odd values made harmless. */
export const attachmentSchemaClient: z.ZodType<Attachment> = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(4096),
  size: z.number().int().min(0),
  kind: z.enum(ATTACHMENT_KINDS).catch('file'),
  mime: z.string().max(255).catch('application/octet-stream'),
  width: side.optional().catch(undefined),
  height: side.optional().catch(undefined),
});

/** The signed-URL target of an attachment (main spec §7): the fileId itself. */
export function fileTarget(fileId: string): string {
  return fileId;
}

// ---- detecting the type from the bytes ----

export interface FileInfo {
  kind: AttachmentKind;
  mime: string;
  width?: number;
  height?: number;
}

const OCTET_STREAM = 'application/octet-stream';

const ascii = (b: Uint8Array, i: number, s: string) => b.length >= i + s.length && [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));

/** ISO base media (`ftyp`) brands a browser plays as MP4; M4A/M4B are audio. Anything else (HEIC, AVIF, 3GP…) is a plain file. */
const MP4_VIDEO_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'M4VP', 'mmp4', 'MSNV']);
const MP4_AUDIO_BRANDS = new Set(['M4A ', 'M4B ']);

function mp4(b: Uint8Array): FileInfo | null {
  if (!ascii(b, 4, 'ftyp') || b.length < 12) return null;
  const brand = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!);
  if (MP4_AUDIO_BRANDS.has(brand)) return { kind: 'audio', mime: 'audio/mp4' };
  if (MP4_VIDEO_BRANDS.has(brand)) return { kind: 'video', mime: 'video/mp4' };
  return null;
}

/** EBML (1A 45 DF A3) whose DocType, in the header, is `webm`. Matroska (.mkv) stays a plain file. */
function webm(b: Uint8Array): FileInfo | null {
  if (b.length < 4 || b[0] !== 0x1a || b[1] !== 0x45 || b[2] !== 0xdf || b[3] !== 0xa3) return null;
  const end = Math.min(b.length, 64);
  for (let i = 4; i + 6 <= end; i++) {
    // DocType element (42 82), a one-byte size of 4 (0x84), then the text.
    if (b[i] === 0x42 && b[i + 1] === 0x82 && b[i + 2] === 0x84 && ascii(b, i + 3, 'webm')) return { kind: 'video', mime: 'video/webm' };
  }
  return null;
}

/** MP3: an ID3v2 tag, or an MPEG-1/2/2.5 Layer III frame header. */
function mp3(b: Uint8Array): FileInfo | null {
  if (ascii(b, 0, 'ID3')) return { kind: 'audio', mime: 'audio/mpeg' };
  // 11 sync bits, a version that is not "reserved" (01), layer bits 01 (Layer III).
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe6) === 0xe2 && (b[1]! & 0x18) !== 0x08) return { kind: 'audio', mime: 'audio/mpeg' };
  return null;
}

/**
 * The kind and type of a file from its first bytes (pass at least ATTACHMENT_LIMITS.sniffBytes
 * of it, or all of a smaller file): PNG, JPEG, GIF and WebP are images with their sides read
 * from the header; MP4 and WebM are video; MP3, OGG and M4A are audio; PDF is a `file` of type
 * `application/pdf`; anything else, including an image whose header cannot be read, is a
 * `file` of type `application/octet-stream`. SVG and HTML are never images: they are files.
 */
export function fileInfo(head: Uint8Array): FileInfo {
  const image = imageInfo(head);
  if (image) return { kind: 'image', mime: image.mime, width: image.width, height: image.height };
  const media = mp4(head) ?? webm(head) ?? mp3(head);
  if (media) return media;
  if (ascii(head, 0, 'OggS')) return { kind: 'audio', mime: 'audio/ogg' };
  if (ascii(head, 0, '%PDF-')) return { kind: 'file', mime: 'application/pdf' };
  return { kind: 'file', mime: OCTET_STREAM };
}

/** IMAGE_TOO_LARGE (spec §2): more than 8192 px on a side or more than 40 MP. */
export function isImageTooLarge(info: Pick<FileInfo, 'width' | 'height'>): boolean {
  const { maxImageSide, maxImagePixels } = ATTACHMENT_LIMITS;
  const w = info.width ?? 0;
  const h = info.height ?? 0;
  return w > maxImageSide || h > maxImageSide || w * h > maxImagePixels;
}

// ---- names ----

// Controls, format characters (bidi, zero-width) and lone surrogates.
const NAME_JUNK = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
// Not allowed in a file name on Windows (and `/` nowhere): main spec §7.
const NAME_RESERVED = /[/\\:*?"<>|]/g;
const EXTENSION = /\.[^.]{1,16}$/u;

/**
 * A file name safe to show and to save under (main spec §7): NFC, no control, bidi or
 * zero-width characters, `/ \ : * ? " < > |` replaced by `_`, whitespace collapsed, no
 * trailing dots or spaces, at most ATTACHMENT_LIMITS.nameMax code points (the extension is
 * kept). Never empty: `file` when nothing is left.
 */
export function cleanFileName(raw: string): string {
  let name = raw
    .slice(0, ATTACHMENT_LIMITS.nameInputMax * 4)
    .normalize('NFC')
    .replace(NAME_JUNK, '')
    .replace(NAME_RESERVED, '_')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/u, '');
  const points = Array.from(name);
  if (points.length > ATTACHMENT_LIMITS.nameMax) {
    const ext = Array.from(EXTENSION.exec(name)?.[0] ?? '');
    name = [...points.slice(0, ATTACHMENT_LIMITS.nameMax - ext.length), ...ext].join('').trim();
  }
  return /^\.*$/.test(name) ? 'file' : name;
}

// ---- server storage (spec §2: Server settings → Overview) ----

/** `server.storage {}` → ServerStorage (MANAGE_SERVER). */
export const serverStorageSchema = z.strictObject({});

export interface ServerStorage {
  /** Bytes of every stored attachment, used or still waiting for its message. */
  usedBytes: number;
  uploadLimitMb: number;
  storageQuotaMb: number;
}

export const serverStorageSchemaClient: z.ZodType<ServerStorage> = z.object({
  usedBytes: z.number().int().min(0),
  uploadLimitMb: z.number().int().min(0),
  storageQuotaMb: z.number().int().min(0),
});
