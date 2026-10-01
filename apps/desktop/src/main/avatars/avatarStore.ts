// My profile photo (spec 2026-10-01 §3): <userData>/profile/avatar.webp|gif plus avatar.json
// ({ version: 1, hash, mime }). The renderer only ever sees { hash, mime }, never a path.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { avatarHashSchema } from '@ghostlink/shared';
import type { AvatarInfo } from '../../shared/profileTypes.js';
import { readJsonFile, writeFileAtomic, writeJsonAtomic } from '../files.js';
import { checkMyAvatar, ownBytes } from './avatarBytes.js';

const recordSchema = z.strictObject({
  version: z.literal(1),
  hash: avatarHashSchema,
  mime: z.enum(['image/webp', 'image/gif']),
});

const EXTENSIONS = { 'image/webp': 'webp', 'image/gif': 'gif' } as const satisfies Record<AvatarInfo['mime'], string>;

/** My photo with its bytes (to upload, or to serve at app://ghostlink/_avatar/<hash>). */
export interface MyAvatar {
  info: AvatarInfo;
  bytes: Uint8Array;
}

export class AvatarStore {
  readonly #dir: string;
  #current: MyAvatar | null;

  private constructor(dir: string, current: MyAvatar | null) {
    this.#dir = dir;
    this.#current = current;
  }

  /** Reads the stored photo, checking it again; anything inconsistent means no photo. */
  static load(userDataDir: string): AvatarStore {
    const dir = join(userDataDir, 'profile');
    const record = readJsonFile(join(dir, 'avatar.json'), recordSchema.nullable(), () => null);
    let current: MyAvatar | null = null;
    if (record !== null) {
      const path = join(dir, `avatar.${EXTENSIONS[record.mime]}`);
      const bytes = existsSync(path) ? readFileSync(path) : null;
      let info: AvatarInfo | null;
      try {
        info = bytes === null ? null : checkMyAvatar(bytes);
      } catch {
        info = null;
      }
      // A crash between writing the photo and its record leaves the new photo with the old
      // record: the file is the truth when it is a valid photo of the recorded type.
      if (bytes !== null && info !== null && info.mime === record.mime) {
        current = { info, bytes };
        if (info.hash !== record.hash) writeJsonAtomic(join(dir, 'avatar.json'), { version: 1, ...info });
      }
    }
    return new AvatarStore(dir, current);
  }

  get(): AvatarInfo | null {
    return this.#current === null ? null : { ...this.#current.info };
  }

  current(): MyAvatar | null {
    return this.#current;
  }

  /** Checks the photo again (WebP or GIF, 256×256, ≤ 2 MB; BAD_REQUEST otherwise) and makes it mine. */
  set(input: Uint8Array): AvatarInfo {
    const bytes = ownBytes(input);
    const info = checkMyAvatar(bytes);
    mkdirSync(this.#dir, { recursive: true });
    // The photo first, then the record that points at it: a crash in between keeps a consistent pair.
    writeFileAtomic(join(this.#dir, `avatar.${EXTENSIONS[info.mime]}`), bytes);
    writeJsonAtomic(join(this.#dir, 'avatar.json'), { version: 1, ...info });
    for (const [mime, ext] of Object.entries(EXTENSIONS)) {
      if (mime !== info.mime) rmSync(join(this.#dir, `avatar.${ext}`), { force: true });
    }
    this.#current = { info, bytes };
    return { ...info };
  }

  /** Back to initials: the record goes first, so a crash never brings an old photo back. */
  clear(): void {
    rmSync(join(this.#dir, 'avatar.json'), { force: true });
    for (const ext of Object.values(EXTENSIONS)) rmSync(join(this.#dir, `avatar.${ext}`), { force: true });
    this.#current = null;
  }
}
