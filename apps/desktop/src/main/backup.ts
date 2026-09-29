// Identity backup: the .ghostkey file (spec §3.4).
//
//   offset  size  field
//        0     5  magic "GLKEY" (CRYPTO_LABELS.keyFileMagic, frozen)
//        5     1  version (1)
//        6     1  log2(N) of scrypt      } parameters, bounded on import
//        7     1  r                      } (N ≤ 2^20, r ≤ 16, p ≤ 4, memory < 256 MiB)
//        8     1  p                      }
//        9    16  salt
//       25    12  AES-GCM IV
//       37    32  AES-256-GCM ciphertext of the 32-byte master seed
//       69    16  GCM tag
// key = scrypt(NFC(password), salt, 32 bytes, N=2^17, r=8, p=1, maxmem 256 MiB);
// the whole 37-byte header is the GCM additional data, so no header byte can change.
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import { CRYPTO_LABELS } from '@ghostlink/shared';
import { AppError } from '../shared/appErrors.js';
import { IPC, type BackupIpcChannel, type IdentityStatus, type IpcArgs, type IpcReturn } from '../shared/ipcTypes.js';
import { writeFileAtomic } from './files.js';
import type { IdentityStore } from './identity.js';

export const GHOSTKEY_VERSION = 1;
export const GHOSTKEY_HEADER_BYTES = 37;
export const GHOSTKEY_SIZE = GHOSTKEY_HEADER_BYTES + 32 + 16;
export const GHOSTKEY_EXTENSION = 'ghostkey';
export const BACKUP_PASSWORD_MIN = 8;
export const BACKUP_PASSWORD_MAX = 1_024;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const DEFAULT_KDF = { logN: 17, r: 8, p: 1 } as const;
const MAGIC = Buffer.from(CRYPTO_LABELS.keyFileMagic, 'latin1');

export interface KdfParams {
  logN: number;
  r: number;
  p: number;
}

function scrypt(password: Buffer, salt: Buffer, params: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, 32, { N: 2 ** params.logN, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM }, (e, key) => (e ? reject(e) : resolve(key))),
  );
}

function passwordBytes(password: string): Buffer {
  if (password.length === 0 || password.length > BACKUP_PASSWORD_MAX) throw new AppError('BAD_REQUEST', 'invalid backup password');
  return Buffer.from(password.normalize('NFC'), 'utf8');
}

/** Rejects parameters that would make scrypt a memory or CPU bomb (checked before any KDF work). */
function paramsAllowed(p: KdfParams): boolean {
  return p.logN >= 15 && p.logN <= 20 && p.r >= 1 && p.r <= 16 && p.p >= 1 && p.p <= 4 && 128 * 2 ** p.logN * p.r < SCRYPT_MAXMEM;
}

/** The header fields, or BACKUP_INVALID. */
export function parseHeader(file: Buffer): { version: number; salt: Buffer; iv: Buffer } & KdfParams {
  if (file.length !== GHOSTKEY_SIZE || !file.subarray(0, 5).equals(MAGIC) || file[5] !== GHOSTKEY_VERSION) {
    throw new AppError('BACKUP_INVALID', 'not a .ghostkey file of a supported version');
  }
  const params = { logN: file[6]!, r: file[7]!, p: file[8]! };
  if (!paramsAllowed(params)) throw new AppError('BACKUP_INVALID', 'unsupported key-derivation parameters');
  return { version: file[5]!, ...params, salt: file.subarray(9, 25), iv: file.subarray(25, 37) };
}

export async function encryptBackup(seed: Uint8Array, password: string, kdf: Partial<KdfParams> = {}): Promise<Buffer> {
  if (seed.length !== 32) throw new AppError('BAD_REQUEST', 'a seed has 32 bytes');
  if ([...password.normalize('NFC')].length < BACKUP_PASSWORD_MIN) throw new AppError('BAD_REQUEST', 'backup password too short');
  const params: KdfParams = { ...DEFAULT_KDF, ...kdf };
  if (!paramsAllowed(params)) throw new AppError('BAD_REQUEST', 'unsupported key-derivation parameters');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([GHOSTKEY_VERSION, params.logN, params.r, params.p]), salt, iv]);
  const key = await scrypt(passwordBytes(password), salt, params);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(seed), cipher.final(), cipher.getAuthTag()]);
  key.fill(0);
  return Buffer.concat([header, body]);
}

/** The master seed; BACKUP_INVALID for a malformed file, BAD_PASSWORD when authentication fails. */
export async function decryptBackup(file: Buffer, password: string): Promise<Buffer> {
  const { salt, iv, ...params } = parseHeader(file);
  const key = await scrypt(passwordBytes(password), salt, params);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(file.subarray(0, GHOSTKEY_HEADER_BYTES));
    decipher.setAuthTag(file.subarray(GHOSTKEY_HEADER_BYTES + 32));
    return Buffer.concat([decipher.update(file.subarray(GHOSTKEY_HEADER_BYTES, GHOSTKEY_HEADER_BYTES + 32)), decipher.final()]);
  } catch {
    // A wrong password and a modified file look the same to AES-GCM.
    throw new AppError('BAD_PASSWORD', 'wrong password or modified file');
  } finally {
    key.fill(0);
  }
}

/** Native save/open dialogs (Electron's dialog in production, fakes in tests). */
export interface BackupDialogs {
  save(defaultName: string): Promise<string | null>;
  open(): Promise<string | null>;
}

export interface IdentityBackupDeps {
  identity: Pick<IdentityStore, 'status' | 'exportSeed' | 'importSeed' | 'deleteIdentity'>;
  dialogs: BackupDialogs;
  /** Closes the current server connection (made with the identity being replaced). */
  disconnect(): Promise<void>;
  /** Tests use cheaper scrypt parameters. */
  kdf?: Partial<KdfParams>;
  now?: () => Date;
}

/**
 * Export, import (pick the file, then the password) and delete, for the IPC layer.
 * The seed and the file bytes never leave the main process.
 */
export class IdentityBackup {
  readonly #d: IdentityBackupDeps;
  #picked: Buffer | null = null;

  constructor(deps: IdentityBackupDeps) {
    this.#d = deps;
  }

  static defaultFileName(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `ghostlink-identity-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.${GHOSTKEY_EXTENSION}`;
  }

  async exportTo(password: string): Promise<{ saved: boolean; fileName: string | null }> {
    if ([...password.normalize('NFC')].length < BACKUP_PASSWORD_MIN) throw new AppError('BAD_REQUEST', 'backup password too short');
    const seed = this.#d.identity.exportSeed();
    try {
      const path = await this.#d.dialogs.save(IdentityBackup.defaultFileName((this.#d.now ?? (() => new Date()))()));
      if (path === null) return { saved: false, fileName: null };
      writeFileAtomic(path, await encryptBackup(seed, password, this.#d.kdf));
      return { saved: true, fileName: basename(path) };
    } finally {
      seed.fill(0);
    }
  }

  /** Opens the file dialog and keeps the (validated) file for importPicked(). */
  async pick(): Promise<{ picked: boolean; fileName: string | null }> {
    this.#picked = null;
    const path = await this.#d.dialogs.open();
    if (path === null) return { picked: false, fileName: null };
    if (statSync(path).size !== GHOSTKEY_SIZE) throw new AppError('BACKUP_INVALID', 'not a .ghostkey file');
    const bytes = readFileSync(path);
    parseHeader(bytes);
    this.#picked = bytes;
    return { picked: true, fileName: basename(path) };
  }

  /** spec §3.4: replaces the current identity (the renderer confirmed twice; `replace` says so). */
  async importPicked(password: string, replace: boolean): Promise<IdentityStatus> {
    const file = this.#picked;
    if (file === null) throw new AppError('BAD_REQUEST', 'no backup file was picked');
    if (this.#d.identity.status === 'ready' && !replace) throw new AppError('BAD_REQUEST', 'replacing the identity needs a confirmation');
    const seed = await decryptBackup(file, password);
    try {
      await this.#d.disconnect();
      this.#d.identity.importSeed(seed);
      this.#picked = null;
      return 'ready';
    } finally {
      seed.fill(0);
    }
  }

  /** spec §3.1: disconnects, then takes the identity out of use (identity.bin is kept as identity.bin.bak-…). */
  async deleteIdentity(): Promise<IdentityStatus> {
    await this.#d.disconnect();
    this.#picked = null;
    this.#d.identity.deleteIdentity();
    return 'none';
  }
}

const password = z.string().min(1).max(BACKUP_PASSWORD_MAX);

export const BACKUP_IPC_ARG_SCHEMAS: { readonly [C in BackupIpcChannel]: z.ZodType<IpcArgs<C>> } = {
  [IPC.identityExportBackup]: z.tuple([password]),
  [IPC.identityPickBackup]: z.tuple([]),
  [IPC.identityImportBackup]: z.tuple([password, z.boolean()]),
  [IPC.identityDelete]: z.tuple([]),
};

type BackupHandlers = { [C in BackupIpcChannel]: (...args: IpcArgs<C>) => IpcReturn<C> | Promise<IpcReturn<C>> };

export function createBackupIpcHandlers(backup: IdentityBackup | undefined): BackupHandlers {
  const b = () => {
    if (!backup) throw new Error('identity backup is not wired');
    return backup;
  };
  return {
    [IPC.identityExportBackup]: (pw) => b().exportTo(pw),
    [IPC.identityPickBackup]: () => b().pick(),
    [IPC.identityImportBackup]: (pw, replace) => b().importPicked(pw, replace),
    [IPC.identityDelete]: () => b().deleteIdentity(),
  };
}
