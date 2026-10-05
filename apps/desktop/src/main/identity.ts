import { createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CRYPTO_LABELS, ProtocolError, utf8 } from '@ghostlink/shared';
import { AppError } from '../shared/appErrors.js';
import type { IdentityStatus } from '../shared/ipcTypes.js';
import { fileTimestamp, freePath, writeFileAtomic } from './files.js';

export type { IdentityStatus } from '../shared/ipcTypes.js';

/** The per-server Ed25519 key. The private half never leaves this closure. */
export interface ServerKey {
  publicKeyRaw: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

/** The subset of Electron's `safeStorage` the store needs (a fake in tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

export const IDENTITY_FILE = 'identity.bin';

// spec §3.2: PKCS#8 DER prefix for a raw 32-byte Ed25519 seed.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SERVER_KEY_ID = /^[A-Za-z0-9_-]{43}$/;
/** base64 of exactly 32 bytes: what create() encrypts. */
const SEED_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * seed_srv = HKDF-SHA256(ikm = masterSeed, salt = "ghostlink/identity/v1",
 * info = UTF-8 of the serverKeyId string, 32 bytes) — spec §3.2. Each server gets
 * an unrelated key, so servers cannot link one person across them.
 */
export function deriveServerSeed(masterSeed: Uint8Array, serverKeyId: string): Uint8Array {
  if (masterSeed.length !== 32) throw new RangeError('masterSeed must be 32 bytes');
  if (!SERVER_KEY_ID.test(serverKeyId)) throw new ProtocolError('BAD_REQUEST', 'invalid serverKeyId');
  return new Uint8Array(hkdfSync('sha256', masterSeed, utf8(CRYPTO_LABELS.identitySalt), utf8(serverKeyId), 32));
}

/**
 * friendSeed = HKDF-SHA256(ikm = masterSeed, salt = "ghostlink/friend/v1", info = "", 32 bytes),
 * friends spec §2. The friend key comes from it and is unrelated to every per-server key, so a
 * server cannot link a person to their friends.
 */
export function deriveFriendSeed(masterSeed: Uint8Array): Uint8Array {
  if (masterSeed.length !== 32) throw new RangeError('masterSeed must be 32 bytes');
  return new Uint8Array(hkdfSync('sha256', masterSeed, utf8(CRYPTO_LABELS.friendSalt), new Uint8Array(0), 32));
}

/** Ed25519 key from a 32-byte seed, built exactly like the server's test identities (spec §3.2). */
export function serverKeyFromSeed(seed: Uint8Array): ServerKey {
  if (seed.length !== 32) throw new RangeError('seed must be 32 bytes');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  if (x === undefined) throw new Error('Ed25519 key without a public part');
  return {
    publicKeyRaw: new Uint8Array(Buffer.from(x, 'base64url')),
    sign: (message) => new Uint8Array(sign(null, message, privateKey)),
  };
}

/**
 * The master seed in `<userData>/identity.bin`, encrypted with safeStorage (spec §3.1).
 *
 * - `none`: no file yet — `create()` makes one.
 * - `ready`: decrypted — `serverKey()` works.
 * - `locked`: the file exists but cannot be decrypted (keychain denied, Local State
 *   lost, corrupted). The file is NEVER rewritten or replaced in this state; only
 *   `replaceKeepingBackup()` moves it aside, after the user confirmed twice.
 */
export class IdentityStore {
  readonly #file: string;
  readonly #crypto: SafeStorageLike;
  readonly #now: () => Date;
  #status: IdentityStatus = 'none';
  #masterSeed: Buffer | null = null;

  private constructor(userDataDir: string, crypto: SafeStorageLike, now: () => Date) {
    this.#file = join(userDataDir, IDENTITY_FILE);
    this.#crypto = crypto;
    this.#now = now;
  }

  /** Call only after app.whenReady(): safeStorage is unavailable before it. */
  static load(userDataDir: string, crypto: SafeStorageLike, opts: { now?: () => Date } = {}): IdentityStore {
    const store = new IdentityStore(userDataDir, crypto, opts.now ?? (() => new Date()));
    store.#read();
    return store;
  }

  get status(): IdentityStatus {
    return this.#status;
  }

  /** Generates and stores a new master seed. Only when status is 'none'. */
  create(): void {
    if (this.#status !== 'none') throw new AppError('BAD_REQUEST', 'an identity already exists');
    if (existsSync(this.#file)) {
      // Appeared since load (another tool?): never overwrite it, look at it instead.
      this.#read();
      throw new AppError('BAD_REQUEST', 'identity.bin already exists');
    }
    if (!this.#crypto.isEncryptionAvailable()) throw new AppError('ENCRYPTION_UNAVAILABLE');
    const seed = randomBytes(32);
    const encoded = seed.toString('base64'); // encryptString only takes strings
    const blob = this.#crypto.encryptString(encoded);
    // Never persist something this machine cannot read back.
    if (!this.#decrypts(blob, encoded)) throw new AppError('ENCRYPTION_UNAVAILABLE', 'safeStorage round-trip failed');
    writeFileAtomic(this.#file, blob);
    this.#masterSeed = seed;
    this.#status = 'ready';
  }

  /** Tries to decrypt identity.bin again (e.g. after the user unlocked the keychain). */
  retry(): IdentityStatus {
    this.#read();
    return this.#status;
  }

  /**
   * Only when 'locked': renames identity.bin to identity.bin.bak-<yyyyMMdd-HHmmss>
   * (never overwriting an older backup) and moves to 'none', so create() can run.
   */
  replaceKeepingBackup(): void {
    if (this.#status !== 'locked') throw new AppError('BAD_REQUEST', 'only a locked identity can be replaced');
    this.#moveAside();
    this.#masterSeed = null;
    this.#status = 'none';
  }

  /** spec §3.4: the master seed, for the .ghostkey backup only (main process; never sent to the renderer). */
  exportSeed(): Buffer {
    if (this.#status !== 'ready' || this.#masterSeed === null) throw new AppError('IDENTITY_UNAVAILABLE');
    return Buffer.from(this.#masterSeed);
  }

  /**
   * spec §3.4 "Importar": replaces the identity with a restored seed. An existing
   * identity.bin (ready or locked) is renamed to identity.bin.bak-<date>, never overwritten.
   * The caller asks for the double confirmation first.
   */
  importSeed(seed: Uint8Array): void {
    if (seed.length !== 32) throw new AppError('BAD_REQUEST', 'a seed has 32 bytes');
    if (!this.#crypto.isEncryptionAvailable()) throw new AppError('ENCRYPTION_UNAVAILABLE');
    const encoded = Buffer.from(seed).toString('base64');
    const blob = this.#crypto.encryptString(encoded);
    if (!this.#decrypts(blob, encoded)) throw new AppError('ENCRYPTION_UNAVAILABLE', 'safeStorage round-trip failed');
    if (existsSync(this.#file)) this.#moveAside();
    writeFileAtomic(this.#file, blob);
    this.#masterSeed = Buffer.from(seed);
    this.#status = 'ready';
  }

  /**
   * spec §3.1 "Apagar a identidade": takes the identity out of use on this device. The
   * double confirmation happens in the renderer, so main never destroys the key: like
   * import, identity.bin is renamed to identity.bin.bak-<yyyyMMdd-HHmmss> (never
   * overwriting an older backup), and a buggy or compromised page cannot lose it for good.
   */
  deleteIdentity(): void {
    if (existsSync(this.#file)) this.#moveAside();
    this.#masterSeed?.fill(0);
    this.#masterSeed = null;
    this.#status = 'none';
  }

  serverKey(serverKeyId: string): ServerKey {
    if (this.#status !== 'ready' || this.#masterSeed === null) throw new AppError('IDENTITY_UNAVAILABLE');
    return serverKeyFromSeed(deriveServerSeed(this.#masterSeed, serverKeyId));
  }

  /** The seed of the friend key (friends spec §2), for the P2P engine only: main process, never the renderer. */
  friendSeed(): Uint8Array {
    if (this.#status !== 'ready' || this.#masterSeed === null) throw new AppError('IDENTITY_UNAVAILABLE');
    return deriveFriendSeed(this.#masterSeed);
  }

  /** identity.bin → identity.bin.bak-<yyyyMMdd-HHmmss>, never overwriting an older backup. */
  #moveAside(): void {
    renameSync(this.#file, freePath(`${this.#file}.bak-${fileTimestamp(this.#now())}`));
  }

  #decrypts(blob: Buffer, expected: string): boolean {
    try {
      return this.#crypto.decryptString(blob) === expected;
    } catch {
      return false;
    }
  }

  #read(): void {
    this.#masterSeed = null;
    if (!existsSync(this.#file)) {
      this.#status = 'none';
      return;
    }
    // The file exists: from here on every failure means 'locked', and the file is left alone.
    this.#status = 'locked';
    if (!this.#crypto.isEncryptionAvailable()) return;
    let encoded: string;
    try {
      encoded = this.#crypto.decryptString(readFileSync(this.#file));
    } catch {
      return;
    }
    if (!SEED_BASE64.test(encoded)) return;
    this.#masterSeed = Buffer.from(encoded, 'base64');
    this.#status = 'ready';
  }
}
