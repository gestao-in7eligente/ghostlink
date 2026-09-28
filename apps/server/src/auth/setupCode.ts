import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dataPaths, writeSecretFile } from '../config/paths.js';
import type { Db } from '../db/database.js';
import { getMeta } from '../db/serverMeta.js';

const NORMALIZED = /^[0-9a-f]{32}$/;

/** 128 random bits shown as 4 groups of 8 hex digits: "3f9a2b1c-7d4e5f60-a1b2c3d4-e5f60718". */
export function generateSetupCode(): string {
  const hex = randomBytes(16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 16), hex.slice(16, 24), hex.slice(24, 32)].join('-');
}

/** Accepts any case, spaces and dashes; returns the 32 hex digits or null. */
export function normalizeSetupCode(input: string): string | null {
  const s = input.toLowerCase().replace(/[\s-]/g, '');
  return NORMALIZED.test(s) ? s : null;
}

function hashCode(normalized: string): string {
  return createHash('sha256').update(normalized).digest('base64url');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Issues a fresh code: the DB keeps only its hash, the plain code goes to data/setup-code.txt (0600). */
export function resetSetupCode(db: Db, dataDir: string): string {
  const code = generateSetupCode();
  db.run('UPDATE server_meta SET setup_code_hash = ? WHERE id = 1', hashCode(normalizeSetupCode(code)!));
  writeSecretFile(dataPaths(dataDir).setupCodeFile, `${code}\n`);
  return code;
}

/**
 * Returns the current setup code, creating one when the server has no owner yet.
 * Returns null once the code was consumed (the server has an owner and no pending code).
 */
export function ensureSetupCode(db: Db, dataDir: string): string | null {
  const meta = getMeta(db);
  if (meta.setupCodeHash === null) {
    return meta.ownerUserId === null ? resetSetupCode(db, dataDir) : null;
  }
  const file = dataPaths(dataDir).setupCodeFile;
  if (existsSync(file)) {
    const code = readFileSync(file, 'utf8').trim();
    const normalized = normalizeSetupCode(code);
    if (normalized !== null && sameHash(hashCode(normalized), meta.setupCodeHash)) return code;
  }
  // The file was lost or edited: the old code can never be shown again, so rotate it.
  return resetSetupCode(db, dataDir);
}

/** True when `code` matches the pending setup code (does not consume it). */
export function checkSetupCode(db: Db, code: string): boolean {
  const normalized = normalizeSetupCode(code);
  const { setupCodeHash } = getMeta(db);
  return normalized !== null && setupCodeHash !== null && sameHash(hashCode(normalized), setupCodeHash);
}

/**
 * Makes `userId` the owner and burns the code in one UPDATE guarded by the
 * current hash, so two concurrent uses cannot both succeed. Deletes the file.
 * Call it inside the admission transaction.
 */
export function consumeSetupCode(db: Db, dataDir: string, code: string, userId: string): boolean {
  if (!checkSetupCode(db, code)) return false;
  const { setupCodeHash } = getMeta(db);
  const r = db.run(
    'UPDATE server_meta SET owner_user_id = ?, setup_code_hash = NULL WHERE id = 1 AND setup_code_hash = ?',
    userId,
    setupCodeHash,
  );
  if (r.changes !== 1) return false;
  rmSync(dataPaths(dataDir).setupCodeFile, { force: true });
  return true;
}
