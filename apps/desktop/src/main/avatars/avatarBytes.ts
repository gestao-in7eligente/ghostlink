// What makes bytes a profile photo (spec 2026-10-01 §3, §7). Main never decodes an image: it
// reads the type and the sides from the header and checks the SHA-256, and only the sandboxed
// renderer decodes. Nothing here logs the bytes or the hash.
import { createHash } from 'node:crypto';
import { AVATAR_HASH, AVATAR_LIMITS, imageInfo, type ImageInfo } from '@ghostlink/shared';
import { AppError } from '../../shared/appErrors.js';
import type { AvatarInfo } from '../../shared/profileTypes.js';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** An owned copy: a Uint8Array from IPC may be a view over a larger buffer. */
export function ownBytes(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes); // copies
}

/**
 * My photo as the renderer must produce it (spec §2, §3): WebP or GIF, exactly outputSide×outputSide,
 * at most maxBytes. AppError('BAD_REQUEST') otherwise.
 */
export function checkMyAvatar(bytes: Uint8Array): AvatarInfo {
  if (bytes.byteLength < 1 || bytes.byteLength > AVATAR_LIMITS.maxBytes) throw new AppError('BAD_REQUEST', 'the photo is empty or too large');
  const info = imageInfo(bytes);
  if (info === null || (info.mime !== 'image/webp' && info.mime !== 'image/gif')) throw new AppError('BAD_REQUEST', 'the photo must be WebP or GIF');
  if (info.width !== AVATAR_LIMITS.outputSide || info.height !== AVATAR_LIMITS.outputSide) throw new AppError('BAD_REQUEST', 'the photo has the wrong size');
  return { hash: sha256Hex(bytes), mime: info.mime };
}

/**
 * Someone's photo as a server may hand it out: the bytes are exactly the photo `hash` names
 * (SHA-256), one of the four image types, sides within the server's limits and at most maxBytes.
 * The type to serve it with, or null.
 */
export function verifiedAvatar(hash: string, bytes: Uint8Array): ImageInfo | null {
  if (!AVATAR_HASH.test(hash) || bytes.byteLength < 1 || bytes.byteLength > AVATAR_LIMITS.maxBytes) return null;
  const info = imageInfo(bytes);
  if (info === null) return null;
  const sideOk = (side: number) => side >= AVATAR_LIMITS.minSide && side <= AVATAR_LIMITS.maxSide;
  if (!sideOk(info.width) || !sideOk(info.height)) return null;
  return sha256Hex(bytes) === hash ? info : null;
}
