import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GHOSTKEY_HEADER_BYTES,
  GHOSTKEY_SIZE,
  IdentityBackup,
  decryptBackup,
  encryptBackup,
  parseHeader,
  type BackupDialogs,
} from '../../src/main/backup.js';
import { IDENTITY_FILE, IdentityStore, deriveServerSeed } from '../../src/main/identity.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();
const SEED = randomBytes(32);
const KEY_ID = 'k'.repeat(43);

// Fast parameters for most tests; one test runs the real N = 2^17.
const FAST = { logN: 15 };

describe('.ghostkey format (spec §3.4)', () => {
  it('round trip with the spec parameters: GLKEY header, scrypt N=2^17 r=8 p=1', async () => {
    const file = await encryptBackup(SEED, 'correct horse battery staple');
    expect(file).toHaveLength(GHOSTKEY_SIZE);
    expect(file.subarray(0, 5).toString('latin1')).toBe('GLKEY');
    expect(parseHeader(file)).toMatchObject({ version: 1, logN: 17, r: 8, p: 1 });
    expect(await decryptBackup(file, 'correct horse battery staple')).toEqual(SEED);
  });

  it('uses a fresh salt and IV every time', async () => {
    const a = await encryptBackup(SEED, 'password1', FAST);
    const b = await encryptBackup(SEED, 'password1', FAST);
    expect(a.subarray(9, GHOSTKEY_HEADER_BYTES)).not.toEqual(b.subarray(9, GHOSTKEY_HEADER_BYTES));
    expect(a).not.toEqual(b);
  });

  it('refuses a wrong password with BAD_PASSWORD', async () => {
    const file = await encryptBackup(SEED, 'password1', FAST);
    await expect(decryptBackup(file, 'password2')).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
  });

  it('normalizes the password (NFC), so the same text typed differently still works', async () => {
    const file = await encryptBackup(SEED, 'sénha-forte', FAST); // e + combining accent
    expect(await decryptBackup(file, 'sénha-forte')).toEqual(SEED); // precomposed é
  });

  it('detects any tampering: header bytes are authenticated (AAD), ciphertext and tag too', async () => {
    const file = await encryptBackup(SEED, 'password1', FAST);
    // Salt, IV, ciphertext and tag bytes: decryption fails. (The params bytes are checked by the bounds.)
    for (const offset of [9, 20, 25, 30, 36, 37, 50, 68, GHOSTKEY_SIZE - 1]) {
      const copy = Buffer.from(file);
      copy[offset]! ^= 0x01;
      await expect(decryptBackup(copy, 'password1'), `offset ${offset}`).rejects.toMatchObject({ code: expect.stringMatching(/BAD_PASSWORD|BACKUP_INVALID/) });
    }
    // A parameter byte changed to another valid value still fails (AAD covers it).
    const r4 = Buffer.from(file);
    r4[7] = 4;
    await expect(decryptBackup(r4, 'password1')).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
  });

  it.each<[string, (b: Buffer) => Buffer]>([
    ['a wrong magic', (b) => Buffer.concat([Buffer.from('GLKEZ'), b.subarray(5)])],
    ['an unknown version', (b) => Object.assign(Buffer.from(b), { [5]: 2 })],
    ['N below 2^15', (b) => Object.assign(Buffer.from(b), { [6]: 14 })],
    ['N above 2^20 (memory bomb)', (b) => Object.assign(Buffer.from(b), { [6]: 30 })],
    ['r = 0', (b) => Object.assign(Buffer.from(b), { [7]: 0 })],
    ['r above 16', (b) => Object.assign(Buffer.from(b), { [7]: 200 })],
    ['p = 0', (b) => Object.assign(Buffer.from(b), { [8]: 0 })],
    ['p above 4', (b) => Object.assign(Buffer.from(b), { [8]: 9 })],
    ['more than 256 MiB of scrypt memory', (b) => Object.assign(Buffer.from(b), { [6]: 20, [7]: 16 })],
    ['a truncated file', (b) => b.subarray(0, GHOSTKEY_SIZE - 1)],
    ['extra bytes', (b) => Buffer.concat([b, Buffer.from([0])])],
    ['an empty file', () => Buffer.alloc(0)],
  ])('refuses %s as BACKUP_INVALID, before running scrypt', async (_label, mutate) => {
    const file = await encryptBackup(SEED, 'password1', FAST);
    const started = Date.now();
    await expect(decryptBackup(mutate(file), 'password1')).rejects.toMatchObject({ code: 'BACKUP_INVALID' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('refuses to export with a short or huge password, or a seed of the wrong size', async () => {
    await expect(encryptBackup(SEED, 'short', FAST)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(encryptBackup(SEED, 'x'.repeat(1_025), FAST)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(encryptBackup(randomBytes(31), 'password1', FAST)).rejects.toThrow();
  });
});

describe('IdentityStore: export, import, delete (spec §3.1, §3.4)', () => {
  let store: IdentityStore;
  beforeEach(() => {
    store = IdentityStore.load(dir.path, new FakeSafeStorage());
  });

  it('exports the seed only when ready', () => {
    expect(() => store.exportSeed()).toThrow(expect.objectContaining({ code: 'IDENTITY_UNAVAILABLE' }));
    store.create();
    expect(store.exportSeed()).toHaveLength(32);
  });

  it('imports a seed on a fresh device: same per-server keys as the original', () => {
    store.importSeed(SEED);
    expect(store.status).toBe('ready');
    const again = IdentityStore.load(dir.path, new FakeSafeStorage());
    expect(again.serverKey(KEY_ID).publicKeyRaw).toEqual(store.serverKey(KEY_ID).publicKeyRaw);
    expect(deriveServerSeed(store.exportSeed(), KEY_ID)).toEqual(deriveServerSeed(SEED, KEY_ID));
  });

  it('import over an existing identity keeps the old file as identity.bin.bak-<date>', () => {
    store.create();
    const old = readFileSync(join(dir.path, IDENTITY_FILE));
    store.importSeed(SEED);
    const backups = readdirSync(dir.path).filter((f) => f.startsWith(`${IDENTITY_FILE}.bak-`));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir.path, backups[0]!))).toEqual(old);
    expect(store.exportSeed()).toEqual(SEED);
  });

  it('import also rescues a locked identity (the locked file is kept aside, never overwritten)', () => {
    writeFileSync(join(dir.path, IDENTITY_FILE), 'undecryptable');
    const locked = IdentityStore.load(dir.path, new FakeSafeStorage());
    expect(locked.status).toBe('locked');
    locked.importSeed(SEED);
    expect(locked.status).toBe('ready');
    const backups = readdirSync(dir.path).filter((f) => f.startsWith(`${IDENTITY_FILE}.bak-`));
    expect(readFileSync(join(dir.path, backups[0]!), 'utf8')).toBe('undecryptable');
  });

  it('refuses to import without secure storage', () => {
    const noCrypto = IdentityStore.load(dir.path, Object.assign(new FakeSafeStorage(), { available: false }));
    expect(() => noCrypto.importSeed(SEED)).toThrow(expect.objectContaining({ code: 'ENCRYPTION_UNAVAILABLE' }));
    expect(existsSync(join(dir.path, IDENTITY_FILE))).toBe(false);
  });

  it('delete removes the identity from this device', () => {
    store.create();
    store.deleteIdentity();
    expect(store.status).toBe('none');
    expect(existsSync(join(dir.path, IDENTITY_FILE))).toBe(false);
    expect(() => store.serverKey(KEY_ID)).toThrow();
  });
});

describe('IdentityBackup (the IPC-facing flows)', () => {
  let store: IdentityStore;
  let saved: string | null;
  let opened: string | null;
  let disconnects: number;
  const dialogs: BackupDialogs = {
    save: async () => saved,
    open: async () => opened,
  };

  beforeEach(() => {
    store = IdentityStore.load(dir.path, new FakeSafeStorage());
    saved = join(dir.path, 'backup.ghostkey');
    opened = saved;
    disconnects = 0;
  });

  function backup() {
    return new IdentityBackup({ identity: store, dialogs, disconnect: async () => void disconnects++, kdf: FAST, now: () => new Date(2026, 8, 28) });
  }

  it('exports to the chosen file (owner-only), and reports a cancelled dialog', async () => {
    store.create();
    expect(await backup().exportTo('password1')).toEqual({ saved: true, fileName: 'backup.ghostkey' });
    expect(await decryptBackup(readFileSync(saved!), 'password1')).toEqual(store.exportSeed());
    saved = null;
    expect(await backup().exportTo('password1')).toEqual({ saved: false, fileName: null });
  });

  it('suggests a dated file name', () => {
    expect(IdentityBackup.defaultFileName(new Date(2026, 8, 28))).toBe('ghostlink-identity-20260928.ghostkey');
  });

  it('import: pick (validated at once), then the password; replacing needs an explicit confirmation', async () => {
    store.create();
    const original = store.exportSeed();
    writeFileSync(opened!, await encryptBackup(SEED, 'password1', FAST));
    const flow = backup();
    expect(await flow.pick()).toEqual({ picked: true, fileName: 'backup.ghostkey' });
    await expect(flow.importPicked('password1', false)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(flow.importPicked('wrong-password', true)).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    expect(store.exportSeed()).toEqual(original); // nothing changed yet
    expect(await flow.importPicked('password1', true)).toBe('ready');
    expect(store.exportSeed()).toEqual(SEED);
    expect(disconnects).toBe(1); // the old identity's connection is closed
    await expect(flow.importPicked('password1', true)).rejects.toMatchObject({ code: 'BAD_REQUEST' }); // used up
  });

  it('pick refuses a file that is not a .ghostkey, and oversized files, without keeping them', async () => {
    writeFileSync(opened!, 'not a backup at all');
    await expect(backup().pick()).rejects.toMatchObject({ code: 'BACKUP_INVALID' });
    writeFileSync(opened!, Buffer.alloc(100_000));
    await expect(backup().pick()).rejects.toMatchObject({ code: 'BACKUP_INVALID' });
    opened = null;
    expect(await backup().pick()).toEqual({ picked: false, fileName: null });
  });

  it('delete disconnects first, then removes the identity', async () => {
    store.create();
    await backup().deleteIdentity();
    expect(disconnects).toBe(1);
    expect(store.status).toBe('none');
  });
});
