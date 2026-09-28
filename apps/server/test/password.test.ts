import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('password hashing (scrypt N=2^14, r=8, p=1)', () => {
  it('uses the documented format and a random 16-byte salt', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    const parts = a.split('$');
    expect(parts.slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
    expect(Buffer.from(parts[4]!, 'base64url')).toHaveLength(16);
    expect(Buffer.from(parts[5]!, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects near misses', async () => {
    const stored = await hashPassword('Senha-Forte-1');
    expect(await verifyPassword('Senha-Forte-1', stored)).toBe(true);
    for (const wrong of ['senha-forte-1', 'Senha-Forte-1 ', 'Senha-Forte-', '']) {
      expect(await verifyPassword(wrong, stored), wrong).toBe(false);
    }
  });

  it('treats canonically equivalent Unicode passwords as equal (NFKC)', async () => {
    const stored = await hashPassword('café');
    expect(await verifyPassword('café', stored)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['wrong scheme', 'bcrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['too few fields', 'scrypt$16384$8$1$AAAA'],
    ['N not a power of two', 'scrypt$10000$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['memory bomb N=2^30', 'scrypt$1073741824$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['CPU bomb p=1000', 'scrypt$16384$8$1000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['short salt', 'scrypt$16384$8$1$AAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['empty hash', 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$'],
  ])('fails closed on a malformed stored hash: %s', async (_label, stored) => {
    await expect(verifyPassword('x', stored)).resolves.toBe(false);
  });
});
