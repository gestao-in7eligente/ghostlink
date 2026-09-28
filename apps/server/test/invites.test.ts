import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProtocolError, parseJoinInput, toBase64Url } from '@ghostlink/shared';
import { Db } from '../src/db/database.js';
import { buildInviteInfo, consumeInviteTx, createInvite } from '../src/invites/invites.js';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghostlink-inv-'));
  db = new Db(join(dir, 'ghostlink.db'));
  db.migrate();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const consume = (code: string, now: number) => db.tx(() => consumeInviteTx(db, code, now));
const row = (code: string) => db.get<{ uses: number; max_uses: number | null; expires_at: number | null; created_by: string | null }>(
  'SELECT uses, max_uses, expires_at, created_by FROM invites WHERE code = ?', code);

describe('createInvite', () => {
  it('creates a 10-char base32 code with the given limits', () => {
    const { code } = createInvite(db, { maxUses: 3, expiresInHours: 24, createdBy: 'u1', now: 1_000 });
    expect(code).toMatch(/^[A-Z2-7]{10}$/);
    expect(row(code)).toEqual({ uses: 0, max_uses: 3, expires_at: 1_000 + 24 * 3_600_000, created_by: 'u1' });
  });

  it('defaults to unlimited uses, no expiry and no creator', () => {
    const { code } = createInvite(db, { now: 0 });
    expect(row(code)).toEqual({ uses: 0, max_uses: null, expires_at: null, created_by: null });
  });

  it('generates distinct codes', () => {
    const codes = new Set(Array.from({ length: 200 }, () => createInvite(db, { now: 0 }).code));
    expect(codes.size).toBe(200);
  });

  it.each([
    [{ maxUses: 0 }], [{ maxUses: -1 }], [{ maxUses: 1.5 }], [{ maxUses: 10_001 }],
    [{ expiresInHours: 0 }], [{ expiresInHours: -2 }], [{ expiresInHours: Number.NaN }], [{ expiresInHours: 24 * 366 }],
  ])('rejects %j', (opts) => {
    expect(() => createInvite(db, { ...opts, now: 0 })).toThrow(ProtocolError);
  });
});

describe('consumeInviteTx', () => {
  it('must run inside a transaction', () => {
    const { code } = createInvite(db, { now: 0 });
    expect(() => consumeInviteTx(db, code, 0)).toThrow(/inside db.tx/);
  });

  it('honours max_uses exactly', () => {
    const { code } = createInvite(db, { maxUses: 2, now: 0 });
    expect([consume(code, 1), consume(code, 1), consume(code, 1)]).toEqual([true, true, false]);
    expect(row(code)?.uses).toBe(2);
  });

  it('refuses at and after expires_at', () => {
    const { code } = createInvite(db, { expiresInHours: 1, now: 0 });
    expect(consume(code, 3_599_999)).toBe(true);
    expect(consume(code, 3_600_000)).toBe(false);
  });

  it('refuses revoked and unknown codes', () => {
    const { code } = createInvite(db, { now: 0 });
    db.run('UPDATE invites SET revoked = 1 WHERE code = ?', code);
    expect(consume(code, 0)).toBe(false);
    expect(consume('AAAAAAAAAA', 0)).toBe(false);
  });

  it('gives the use back when the surrounding transaction rolls back', () => {
    const { code } = createInvite(db, { maxUses: 1, now: 0 });
    expect(() => db.tx(() => {
      consumeInviteTx(db, code, 0);
      throw new Error('later step failed');
    })).toThrow();
    expect(row(code)?.uses).toBe(0);
    expect(consume(code, 0)).toBe(true);
  });
});

describe('buildInviteInfo', () => {
  it('builds link, paste code and web link that all parse back to the same invite', () => {
    const serverKeyId = toBase64Url(new Uint8Array(32).fill(5));
    const info = buildInviteInfo('ABCDEFGH23', { addresses: ['203.0.113.1:7700'], serverKeyId, name: 'Casa' });
    const expected = { kind: 'invite', invite: { addresses: ['203.0.113.1:7700'], serverKeyId, inviteCode: 'ABCDEFGH23', name: 'Casa' } };
    expect(info.code).toBe('ABCDEFGH23');
    expect(parseJoinInput(info.link)).toEqual(expected);
    expect(parseJoinInput(info.pasteCode)).toEqual(expected);
    expect(parseJoinInput(info.webLink)).toEqual(expected);
    expect(info.webLink.startsWith('https://ghostlink.invalid/j/#GL1-')).toBe(true);
  });
});
