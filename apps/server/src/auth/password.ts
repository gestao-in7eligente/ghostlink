import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { createSemaphore } from '../util/semaphore.js';

// spec §3.3: scrypt N=2^14, r=8, p=1, 16-byte salt, at most 2 concurrent computations.
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

export const PASSWORD_CONCURRENCY = 2;
const scryptSlots = createSemaphore(PASSWORD_CONCURRENCY);

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return scryptSlots.run(() => new Promise<Buffer>((resolve, reject) => {
    // NFKC so the same password typed on different keyboards/OSes hashes identically.
    scrypt(password.normalize('NFKC'), salt, keyLength, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  }));
}

/** Returns "scrypt$N$r$p$<salt b64url>$<hash b64url>". */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, N, R, P, KEY_LENGTH);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

/** Constant-time comparison; malformed or out-of-bounds stored hashes simply fail. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Bounds keep a tampered hash from turning verification into a CPU/memory bomb.
  if (!isPowerOfTwo(n) || n > 2 ** 20 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 4) {
    return false;
  }
  if (128 * n * r > MAX_MEMORY) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length < SALT_LENGTH || expected.length < 16 || expected.length > 64) return false;
  const actual = await derive(password, salt, n, r, p, expected.length);
  return timingSafeEqual(actual, expected);
}
