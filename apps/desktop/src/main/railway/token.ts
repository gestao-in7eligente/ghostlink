import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../shared/appErrors.js';
import { writeFileAtomic } from '../files.js';
import type { SafeStorageLike } from '../identity.js';

export const RAILWAY_TOKEN_FILE = 'railway-token.bin';
export const RAILWAY_TOKEN_MAX_LENGTH = 512;

/** Visible ASCII only: Railway tokens are UUIDs, and anything else could not travel in a header. */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

/** The pasted token, trimmed; null when it cannot be a token (then Railway is not even asked). */
export function normalizeToken(raw: string): string | null {
  const token = raw.trim();
  return token.length <= RAILWAY_TOKEN_MAX_LENGTH && TOKEN_SHAPE.test(token) ? token : null;
}

/**
 * The Railway API token in `<userData>/railway-token.bin`, encrypted with safeStorage the
 * way identity.bin is (spec §3.1), 0600. It is read only to talk to Railway from main.
 */
export class RailwayTokenStore {
  readonly #file: string;
  readonly #crypto: SafeStorageLike;

  constructor(userDataDir: string, crypto: SafeStorageLike) {
    this.#file = join(userDataDir, RAILWAY_TOKEN_FILE);
    this.#crypto = crypto;
  }

  canEncrypt(): boolean {
    return this.#crypto.isEncryptionAvailable();
  }

  /** The stored token; null when there is none or this machine can no longer decrypt it. */
  read(): string | null {
    if (!existsSync(this.#file) || !this.#crypto.isEncryptionAvailable()) return null;
    try {
      return normalizeToken(this.#crypto.decryptString(readFileSync(this.#file)));
    } catch {
      return null;
    }
  }

  save(token: string): void {
    if (!this.#crypto.isEncryptionAvailable()) throw new AppError('ENCRYPTION_UNAVAILABLE');
    const blob = this.#crypto.encryptString(token);
    // Never persist something this machine cannot read back.
    if (!this.#decrypts(blob, token)) throw new AppError('ENCRYPTION_UNAVAILABLE', 'safeStorage round-trip failed');
    writeFileAtomic(this.#file, blob);
  }

  #decrypts(blob: Buffer, expected: string): boolean {
    try {
      return this.#crypto.decryptString(blob) === expected;
    } catch {
      return false;
    }
  }

  clear(): void {
    rmSync(this.#file, { force: true });
  }
}
