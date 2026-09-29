import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkSetupCode,
  consumeSetupCode,
  ensureSetupCode,
  generateSetupCode,
  normalizeSetupCode,
  resetSetupCode,
} from '../src/auth/setupCode.js';
import { dataPaths, ensureDataDirs } from '../src/config/paths.js';
import { Db } from '../src/db/database.js';
import { ensureMeta, getMeta } from '../src/db/serverMeta.js';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghostlink-setup-'));
  db = new Db(ensureDataDirs(dir).db);
  db.migrate();
  ensureMeta(db, { name: 'S', joinMode: 'invite', now: 0 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('setup code format', () => {
  it('is 128 random bits in 4 groups of 8 hex digits', () => {
    const code = generateSetupCode();
    expect(code).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);
    expect(generateSetupCode()).not.toBe(code);
  });

  it('normalizes case, spaces and dashes', () => {
    expect(normalizeSetupCode(' 3F9A2B1C 7d4e5f60-A1B2C3D4-e5f60718 ')).toBe('3f9a2b1c7d4e5f60a1b2c3d4e5f60718');
    expect(normalizeSetupCode('3f9a2b1c-7d4e5f60-a1b2c3d4')).toBeNull();
    expect(normalizeSetupCode('zzzzzzzz-7d4e5f60-a1b2c3d4-e5f60718')).toBeNull();
  });
});

describe('ensureSetupCode', () => {
  it('creates a code on first run, stores only its hash and writes the file', () => {
    const code = ensureSetupCode(db, dir)!;
    expect(readFileSync(dataPaths(dir).setupCodeFile, 'utf8').trim()).toBe(code);
    const { setupCodeHash } = getMeta(db);
    expect(setupCodeHash).not.toBeNull();
    expect(setupCodeHash).not.toContain(normalizeSetupCode(code)!);
    expect(ensureSetupCode(db, dir)).toBe(code); // stable across restarts
  });

  it.skipIf(process.platform === 'win32')('writes the file as 0600', () => {
    ensureSetupCode(db, dir);
    expect(statSync(dataPaths(dir).setupCodeFile).mode & 0o777).toBe(0o600);
  });

  it('rotates the code when the file was lost or tampered with', () => {
    const first = ensureSetupCode(db, dir)!;
    rmSync(dataPaths(dir).setupCodeFile);
    const second = ensureSetupCode(db, dir)!;
    expect(second).not.toBe(first);
    expect(checkSetupCode(db, first)).toBe(false);
    writeFileSync(dataPaths(dir).setupCodeFile, 'aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa\n');
    const third = ensureSetupCode(db, dir)!;
    expect(third).not.toBe('aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa');
    expect(checkSetupCode(db, third)).toBe(true);
  });

  it('returns null once the server has an owner', () => {
    const code = ensureSetupCode(db, dir)!;
    expect(db.tx(() => consumeSetupCode(db, dir, code, 'u1'))).toBe(true);
    expect(ensureSetupCode(db, dir)).toBeNull();
  });
});

describe('consumeSetupCode', () => {
  it('makes the user owner, burns the code and deletes the file', () => {
    const code = ensureSetupCode(db, dir)!;
    expect(consumeSetupCode(db, dir, code.toUpperCase(), 'owner-1')).toBe(true);
    expect(getMeta(db)).toMatchObject({ ownerUserId: 'owner-1', setupCodeHash: null });
    expect(existsSync(dataPaths(dir).setupCodeFile)).toBe(false);
    expect(consumeSetupCode(db, dir, code, 'owner-2')).toBe(false);
    expect(getMeta(db).ownerUserId).toBe('owner-1');
  });

  it('rejects a wrong or malformed code without side effects', () => {
    const code = ensureSetupCode(db, dir)!;
    expect(consumeSetupCode(db, dir, generateSetupCode(), 'x')).toBe(false);
    expect(consumeSetupCode(db, dir, 'nope', 'x')).toBe(false);
    expect(getMeta(db).ownerUserId).toBeNull();
    expect(checkSetupCode(db, code)).toBe(true);
  });

  it('resetSetupCode invalidates the previous code', () => {
    const old = ensureSetupCode(db, dir)!;
    const fresh = resetSetupCode(db, dir);
    expect(checkSetupCode(db, old)).toBe(false);
    expect(checkSetupCode(db, fresh)).toBe(true);
  });
});
