import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRegistrationKey } from '@ghostlink/shared';
import { AppError } from '../../shared/appErrors.js';
import { writeFileAtomic } from '../files.js';
import type { SafeStorageLike } from '../identity.js';

export const LICENSE_KEY_FILE = 'license-key.bin';

/**
 * The registration key (GLE-…) in `<userData>/license-key.bin`, encrypted with safeStorage
 * the way identity.bin and the Railway token are (spec §3.1), 0600. It is read only to validate the key
 * with the license service from main; it never reaches the renderer.
 */
export class LicenseKeyStore {
  readonly #file: string;
  readonly #crypto: SafeStorageLike;

  constructor(userDataDir: string, crypto: SafeStorageLike) {
    this.#file = join(userDataDir, LICENSE_KEY_FILE);
    this.#crypto = crypto;
  }

  canEncrypt(): boolean {
    return this.#crypto.isEncryptionAvailable();
  }

  /** The stored key (canonical GLE-…); null when there is none or this machine can no longer decrypt it. */
  read(): string | null {
    if (!existsSync(this.#file) || !this.#crypto.isEncryptionAvailable()) return null;
    try {
      return normalizeRegistrationKey(this.#crypto.decryptString(readFileSync(this.#file)));
    } catch {
      return null;
    }
  }

  save(key: string): void {
    if (!this.#crypto.isEncryptionAvailable()) throw new AppError('ENCRYPTION_UNAVAILABLE');
    const blob = this.#crypto.encryptString(key);
    // Never persist something this machine cannot read back.
    if (!this.#decrypts(blob, key)) throw new AppError('ENCRYPTION_UNAVAILABLE', 'safeStorage round-trip failed');
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
