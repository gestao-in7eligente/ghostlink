// The profile photo's encoding (spec 2026-10-01-foto-de-perfil §2), all in the renderer: a
// still image becomes a 256×256 WebP, an animated one (GIF or WebP, more than one frame) a
// 256×256 GIF. The decisions live here; the decoders and encoders are injected (the app's
// are in browserCodecs.ts), so they are tested without a browser.
import { AVATAR_LIMITS, imageInfo, type ImageMime } from '@ghostlink/shared';
import type { CropSquare, ImageSize } from './cropMath.js';

/** UNREADABLE: "Não deu para abrir essa imagem."; TOO_LARGE: "GIF grande demais…". */
export type AvatarEncodeErrorCode = 'UNREADABLE' | 'TOO_LARGE';

export class AvatarEncodeError extends Error {
  constructor(readonly code: AvatarEncodeErrorCode) {
    super(code);
    this.name = 'AvatarEncodeError';
  }
}

/** One decoded frame. `T` is whatever the platform draws (an ImageBitmap or a VideoFrame in the app). */
export interface DecodedFrame<T> {
  image: T;
  /** How long it shows, in ms; 0 or less when the file does not say. */
  durationMs: number;
  close(): void;
}

export interface DecodedImage<T> extends ImageSize {
  /** 1 for a still image. */
  frameCount: number;
  frame(index: number): Promise<DecodedFrame<T>>;
  close(): void;
}

export interface GifWriter {
  add(rgba: Uint8Array | Uint8ClampedArray, delayMs: number): void;
  /** Bytes written so far. */
  readonly size: number;
  finish(): Uint8Array;
}

export interface AvatarCodecs<T> {
  /** Rejects when the bytes do not decode. */
  decode(bytes: Uint8Array, mime: ImageMime): Promise<DecodedImage<T>>;
  /** The crop of one frame scaled to side×side, as WebP. */
  webp(image: T, crop: CropSquare, side: number, quality: number): Promise<Uint8Array>;
  /** The crop of one frame scaled to side×side, as RGBA pixels. */
  rgba(image: T, crop: CropSquare, side: number): Uint8Array | Uint8ClampedArray;
  /** A GIF of side×side, one palette per frame, looping forever. */
  gif(side: number): GifWriter;
}

/** A picked file that decodes, with what the crop modal needs. */
export interface PickedImage extends ImageSize {
  mime: ImageMime;
  animated: boolean;
}

export interface EncodedAvatar {
  bytes: Uint8Array;
  mime: 'image/webp' | 'image/gif';
}

const WEBP_QUALITY = 0.9;
const DEFAULT_DELAY_MS = 100;
/** Browsers play faster GIF frames (10 ms) at 100 ms; 20 ms is the fastest that plays as written. */
const MIN_DELAY_MS = 20;

/** A frame's delay in the GIF. */
export function frameDelay(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return DEFAULT_DELAY_MS;
  return Math.max(MIN_DELAY_MS, Math.round(durationMs));
}

async function decode<T>(codecs: AvatarCodecs<T>, bytes: Uint8Array, mime: ImageMime): Promise<DecodedImage<T>> {
  try {
    return await codecs.decode(bytes, mime);
  } catch {
    throw new AvatarEncodeError('UNREADABLE');
  }
}

async function frameOf<T>(image: DecodedImage<T>, index: number): Promise<DecodedFrame<T>> {
  try {
    return await image.frame(index);
  } catch {
    throw new AvatarEncodeError('UNREADABLE');
  }
}

/**
 * Checks a picked file before the crop modal opens: at most 10 MB, PNG/JPEG/WebP/GIF by its
 * bytes, and its first frame decodes. Rejects with AvatarEncodeError('UNREADABLE') otherwise.
 */
export async function openAvatarFile<T>(bytes: Uint8Array, codecs: AvatarCodecs<T>): Promise<PickedImage> {
  const info = bytes.length <= AVATAR_LIMITS.inputMaxBytes ? imageInfo(bytes) : null;
  if (!info) throw new AvatarEncodeError('UNREADABLE');
  const image = await decode(codecs, bytes, info.mime);
  try {
    (await frameOf(image, 0)).close();
    return { mime: info.mime, width: image.width, height: image.height, animated: image.frameCount > 1 };
  } finally {
    image.close();
  }
}

/** The cropped photo, ready for `profile.setAvatar`. */
export async function encodeAvatar<T>(picked: { bytes: Uint8Array; mime: ImageMime }, crop: CropSquare, codecs: AvatarCodecs<T>): Promise<EncodedAvatar> {
  const side = AVATAR_LIMITS.outputSide;
  const image = await decode(codecs, picked.bytes, picked.mime);
  try {
    if (image.frameCount <= 1) {
      const frame = await frameOf(image, 0);
      let bytes: Uint8Array;
      try {
        bytes = await codecs.webp(frame.image, crop, side, WEBP_QUALITY);
      } finally {
        frame.close();
      }
      if (bytes.length > AVATAR_LIMITS.maxBytes) throw new AvatarEncodeError('TOO_LARGE');
      return { bytes, mime: 'image/webp' };
    }

    const gif = codecs.gif(side);
    const frames = Math.min(image.frameCount, AVATAR_LIMITS.maxFrames);
    for (let i = 0; i < frames; i++) {
      const frame = await frameOf(image, i);
      try {
        gif.add(codecs.rgba(frame.image, crop, side), frameDelay(frame.durationMs));
      } finally {
        frame.close();
      }
      if (gif.size > AVATAR_LIMITS.maxBytes) throw new AvatarEncodeError('TOO_LARGE');
    }
    const bytes = gif.finish();
    if (bytes.length > AVATAR_LIMITS.maxBytes) throw new AvatarEncodeError('TOO_LARGE');
    return { bytes, mime: 'image/gif' };
  } finally {
    image.close();
  }
}
