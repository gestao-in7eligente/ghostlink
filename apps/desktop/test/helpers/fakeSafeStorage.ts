import type { SafeStorageLike } from '../../src/main/identity.js';

/**
 * Stands in for Electron's safeStorage in plain Node. The "ciphertext" is a
 * reversible XOR behind a `v10` prefix (the prefix Chromium's OSCrypt uses),
 * so a test can see that plaintext never reaches the disk.
 */
export class FakeSafeStorage implements SafeStorageLike {
  /** false = no keychain / DPAPI on this machine. */
  available = true;
  /** true = the keychain denied access or Local State was lost. */
  failDecrypt = false;
  encryptCalls = 0;

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(s: string): Buffer {
    if (!this.available) throw new Error('Encryption is not available.');
    this.encryptCalls++;
    return Buffer.concat([Buffer.from('v10'), Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)]);
  }

  decryptString(b: Buffer): string {
    if (!this.available || this.failDecrypt) {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    }
    if (b.subarray(0, 3).toString() !== 'v10') throw new Error('Unrecognized ciphertext.');
    return Buffer.from(b.subarray(3).map((x) => x ^ 0x5a)).toString('utf8');
  }
}
