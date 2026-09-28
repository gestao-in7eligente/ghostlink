import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toBase64Url } from '@ghostlink/shared';
import { AppError } from '../../src/shared/appErrors.js';
import { IDENTITY_FILE, IdentityStore } from '../../src/main/identity.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();
const file = () => join(dir.path, IDENTITY_FILE);
const KEY_ID = toBase64Url(new Uint8Array(32).fill(9));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const at = () => new Date(2026, 8, 28, 14, 30, 5);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return (e as AppError).code;
  }
  return undefined;
}

/** Bytes, mtime and the directory listing: everything that must not change while locked. */
function snapshot() {
  return { bytes: readFileSync(file()), mtime: statSync(file()).mtimeMs, files: readdirSync(dir.path).sort() };
}

function createdIdentity(crypto = new FakeSafeStorage()) {
  const store = IdentityStore.load(dir.path, crypto);
  store.create();
  return { store, crypto, publicKey: hex(store.serverKey(KEY_ID).publicKeyRaw) };
}

describe('IdentityStore — first run', () => {
  it('starts as none and refuses to hand out keys', () => {
    const store = IdentityStore.load(dir.path, new FakeSafeStorage());
    expect(store.status).toBe('none');
    expect(codeOf(() => store.serverKey(KEY_ID))).toBe('IDENTITY_UNAVAILABLE');
  });

  it('create() encrypts the seed with safeStorage and becomes ready', () => {
    const { store, crypto } = createdIdentity();
    expect(store.status).toBe('ready');
    expect(crypto.encryptCalls).toBe(1);
    const bytes = readFileSync(file());
    expect(bytes.subarray(0, 3).toString()).toBe('v10'); // what encryptString produced, not plaintext
    expect(crypto.decryptString(bytes)).toMatch(/^[A-Za-z0-9+/]{43}=$/); // base64 of 32 bytes
  });

  it('reloads the same identity: same key for the same server', () => {
    const { crypto, publicKey } = createdIdentity();
    const again = IdentityStore.load(dir.path, crypto);
    expect(again.status).toBe('ready');
    expect(hex(again.serverKey(KEY_ID).publicKeyRaw)).toBe(publicKey);
  });

  it('two installations get unrelated identities', () => {
    const keys = ['a', 'b'].map((name) => {
      const userData = join(dir.path, name);
      mkdirSync(userData);
      const store = IdentityStore.load(userData, new FakeSafeStorage());
      store.create();
      return hex(store.serverKey(KEY_ID).publicKeyRaw);
    });
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('refuses a second create() and leaves the file alone', () => {
    const { store } = createdIdentity();
    const before = snapshot();
    expect(codeOf(() => store.create())).toBe('BAD_REQUEST');
    expect(snapshot()).toEqual(before);
  });

  it('does not create an identity when encryption is unavailable (spec §3.1)', () => {
    const crypto = new FakeSafeStorage();
    crypto.available = false;
    const store = IdentityStore.load(dir.path, crypto);
    expect(codeOf(() => store.create())).toBe('ENCRYPTION_UNAVAILABLE');
    expect(store.status).toBe('none');
    expect(readdirSync(dir.path)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('writes identity.bin as 0600', () => {
    createdIdentity();
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });
});

describe('IdentityStore — decryption failure is not a first run (spec §3.1)', () => {
  it.each([
    ['the keychain denies access', (c: FakeSafeStorage) => { c.failDecrypt = true; }],
    ['encryption became unavailable', (c: FakeSafeStorage) => { c.available = false; }],
  ])('locks when %s, and never rewrites the file', (_label, breakIt) => {
    const { crypto } = createdIdentity();
    const before = snapshot();
    breakIt(crypto);
    const locked = IdentityStore.load(dir.path, crypto);
    expect(locked.status).toBe('locked');
    expect(codeOf(() => locked.create())).toBe('BAD_REQUEST');
    expect(codeOf(() => locked.serverKey(KEY_ID))).toBe('IDENTITY_UNAVAILABLE');
    expect(locked.retry()).toBe('locked');
    expect(snapshot()).toEqual(before);
  });

  it('locks on content that decrypts but is not a 32-byte seed', () => {
    const crypto = new FakeSafeStorage();
    writeFileSync(file(), crypto.encryptString('not a seed'));
    const before = snapshot();
    expect(IdentityStore.load(dir.path, crypto).status).toBe('locked');
    expect(snapshot()).toEqual(before);
  });

  it('retry() unlocks the same identity once decryption works again', () => {
    const { crypto, publicKey } = createdIdentity();
    crypto.failDecrypt = true;
    const store = IdentityStore.load(dir.path, crypto);
    expect(store.status).toBe('locked');
    crypto.failDecrypt = false;
    expect(store.retry()).toBe('ready');
    expect(hex(store.serverKey(KEY_ID).publicKeyRaw)).toBe(publicKey);
  });
});

describe('IdentityStore.replaceKeepingBackup', () => {
  it('only works while locked', () => {
    expect(codeOf(() => IdentityStore.load(dir.path, new FakeSafeStorage()).replaceKeepingBackup())).toBe('BAD_REQUEST');
    expect(codeOf(() => createdIdentity().store.replaceKeepingBackup())).toBe('BAD_REQUEST');
  });

  it('moves identity.bin to identity.bin.bak-<timestamp> byte for byte, then allows a new identity', () => {
    const { crypto, publicKey } = createdIdentity();
    const original = readFileSync(file());
    crypto.failDecrypt = true;
    const store = IdentityStore.load(dir.path, crypto, { now: at });
    store.replaceKeepingBackup();
    expect(store.status).toBe('none');
    expect(readdirSync(dir.path)).toEqual([`${IDENTITY_FILE}.bak-20260928-143005`]);
    expect(readFileSync(join(dir.path, `${IDENTITY_FILE}.bak-20260928-143005`)).equals(original)).toBe(true);
    crypto.failDecrypt = false;
    store.create();
    expect(hex(store.serverKey(KEY_ID).publicKeyRaw)).not.toBe(publicKey);
  });

  it('never overwrites an older backup made in the same second', () => {
    const crypto = new FakeSafeStorage();
    for (let i = 0; i < 2; i++) {
      writeFileSync(file(), `garbage ${i}`);
      IdentityStore.load(dir.path, crypto, { now: at }).replaceKeepingBackup();
    }
    expect(readdirSync(dir.path).sort()).toEqual([`${IDENTITY_FILE}.bak-20260928-143005`, `${IDENTITY_FILE}.bak-20260928-143005-1`]);
    expect(readFileSync(join(dir.path, `${IDENTITY_FILE}.bak-20260928-143005`), 'utf8')).toBe('garbage 0');
  });
});
