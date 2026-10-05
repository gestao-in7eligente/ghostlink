import type * as NodeCrypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// Replace scrypt with a controllable fake so the test can observe how many
// derivations run at the same time. vi.mock is hoisted, so its state must be too.
const calls = vi.hoisted((): Array<() => void> => []);
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof NodeCrypto>();
  return {
    ...real,
    scrypt: (_pw: unknown, _salt: unknown, keylen: number, _opts: unknown, cb: (err: Error | null, key: Buffer) => void) => {
      calls.push(() => cb(null, Buffer.alloc(keylen, 1)));
    },
  };
});

const { PASSWORD_CONCURRENCY, verifyPassword } = await import('../src/auth/password.js');

const tick = () => new Promise((r) => setImmediate(r));

describe('password verification concurrency', () => {
  it(`runs at most ${PASSWORD_CONCURRENCY} scrypt derivations at once (spec §13)`, async () => {
    const stored = `scrypt$16384$8$1$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32, 1).toString('base64url')}`;
    const results = Array.from({ length: 6 }, () => verifyPassword('pw', stored));
    await tick();
    expect(calls).toHaveLength(2);
    calls.shift()!();
    await tick();
    expect(calls).toHaveLength(2); // one finished, exactly one more started
    while (calls.length > 0) {
      calls.shift()!();
      await tick();
    }
    expect(await Promise.all(results)).toEqual([true, true, true, true, true, true]);
  });
});
