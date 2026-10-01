// The files of direct messages on this computer (attachments spec §3): every file lives at
// <userData>/friends/files/<hash>, named by the SHA-256 of its bytes, and only ever gets there
// whole and checked. The sender keeps it when the message goes out; the receiver once it came
// from the friend and its hash matched. Files on their way (picked but not sent yet, or parts
// arriving) wait in files/tmp, which is emptied whenever the conversations open.
import { createHash, randomBytes, type Hash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ATTACHMENT_LIMITS, cleanFileName, fileInfo, isImageTooLarge } from '@ghostlink/shared';
import type { DmFileInfo } from '../../shared/dmTypes.js';

/** A file's address: SHA-256 of its bytes, lowercase hex. */
export const FILE_HASH = /^[0-9a-f]{64}$/;
/** The folder, under userData. */
export const DM_FILES_DIR = join('friends', 'files');

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * What a message says about a file (the shared contract's AttachmentMeta plus its hash): the
 * type from the bytes, never the name, and an image's sides. An image too big to show safely
 * (8192 px a side, 40 MP) goes as a plain file of its type: a card with "Baixar".
 */
export function describeFile(name: string, bytes: Uint8Array): DmFileInfo {
  const base = { hash: sha256Hex(bytes), name: cleanFileName(name), size: bytes.byteLength };
  const info = fileInfo(bytes.subarray(0, ATTACHMENT_LIMITS.sniffBytes));
  if (info.kind === 'image' && isImageTooLarge(info)) return { ...base, kind: 'file', mime: info.mime };
  return { ...base, ...info };
}

/** A file arriving part by part; it reaches files/<hash> only if the whole matches the hash. */
export class IncomingFile {
  readonly #path: string;
  readonly #final: string;
  readonly #hash: string;
  readonly #hasher: Hash = createHash('sha256');
  #fd: number | null;

  constructor(tmpPath: string, finalPath: string, hash: string) {
    this.#path = tmpPath;
    this.#final = finalPath;
    this.#hash = hash;
    this.#fd = openSync(tmpPath, 'w', 0o600);
  }

  write(bytes: Uint8Array): void {
    if (this.#fd === null) throw new Error('the file is closed');
    writeSync(this.#fd, bytes);
    this.#hasher.update(bytes);
  }

  /** True once the file is in place; false (and nothing kept) when the bytes are not the ones asked for. */
  finish(): boolean {
    this.#close();
    if (this.#hasher.digest('hex') !== this.#hash) {
      rmSync(this.#path, { force: true });
      return false;
    }
    renameSync(this.#path, this.#final);
    return true;
  }

  abort(): void {
    this.#close();
    rmSync(this.#path, { force: true });
  }

  #close(): void {
    if (this.#fd === null) return;
    closeSync(this.#fd);
    this.#fd = null;
  }
}

/** <userData>/friends/files. Every hash given to it has been checked against FILE_HASH. */
export class DmFiles {
  readonly #dir: string;
  readonly #tmp: string;

  /** `dir` is the files folder itself; leftovers from a previous run are cleared. */
  constructor(dir: string) {
    this.#dir = dir;
    this.#tmp = join(dir, 'tmp');
    rmSync(this.#tmp, { recursive: true, force: true });
    mkdirSync(this.#tmp, { recursive: true });
  }

  /** Where a kept file is (main only: the renderer never sees a path). */
  path(hash: string): string {
    if (!FILE_HASH.test(hash)) throw new Error('not a file hash');
    return join(this.#dir, hash);
  }

  has(hash: string): boolean {
    return FILE_HASH.test(hash) && existsSync(this.path(hash));
  }

  /** The size of a kept file, or null when it is not here. */
  size(hash: string): number | null {
    try {
      return statSync(this.path(hash)).size;
    } catch {
      return null;
    }
  }

  /** Keeps picked bytes aside until the message that carries them goes out (commit). */
  stage(hash: string, bytes: Uint8Array): void {
    if (this.has(hash)) return;
    const part = join(this.#tmp, `${hash}.${randomBytes(6).toString('hex')}`);
    writeFileSync(part, bytes, { mode: 0o600 });
    renameSync(part, this.#staged(hash));
  }

  /** The staged file becomes a kept one; false when it is neither staged nor kept. */
  commit(hash: string): boolean {
    if (this.has(hash)) return true;
    try {
      renameSync(this.#staged(hash), this.path(hash));
      return true;
    } catch {
      return false;
    }
  }

  /** Forgets a staged file that will not be sent. */
  unstage(hash: string): void {
    rmSync(this.#staged(hash), { force: true });
  }

  incoming(hash: string): IncomingFile {
    return new IncomingFile(join(this.#tmp, `in-${hash}.${randomBytes(6).toString('hex')}`), this.path(hash), hash);
  }

  /** Up to `length` bytes from `offset` of a kept file. */
  read(hash: string, offset: number, length: number): Uint8Array {
    const fd = openSync(this.path(hash), 'r');
    try {
      const buffer = Buffer.alloc(length);
      const n = readSync(fd, buffer, 0, length, offset);
      return buffer.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  }

  copyTo(hash: string, destination: string): void {
    copyFileSync(this.path(hash), destination);
  }

  remove(hash: string): void {
    rmSync(this.path(hash), { force: true });
  }

  #staged(hash: string): string {
    if (!FILE_HASH.test(hash)) throw new Error('not a file hash');
    return join(this.#tmp, hash);
  }
}
