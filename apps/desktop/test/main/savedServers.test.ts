import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProtocolError, toBase64Url } from '@ghostlink/shared';
import { SERVERS_FILE, SavedServersStore } from '../../src/main/savedServers.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();
const KEY_A = toBase64Url(new Uint8Array(32).fill(1));
const KEY_B = toBase64Url(new Uint8Array(32).fill(2));

function store() {
  let n = 0;
  return SavedServersStore.load(dir.path, { now: () => 1_000 + n, newId: () => `id-${++n}` });
}

function expectBadRequest(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ProtocolError);
  expect((caught as ProtocolError).code).toBe('BAD_REQUEST');
}

describe('SavedServersStore', () => {
  it('starts empty without writing a file', () => {
    expect(store().list()).toEqual([]);
    expect(existsSync(join(dir.path, SERVERS_FILE))).toBe(false);
  });

  it('adds a server with canonical addresses and a sanitized name, and persists it', () => {
    const s = store();
    const saved = s.upsert({ serverKeyId: KEY_A, name: 'Casa\u202E do Zé', addresses: ['Casa.Example.COM', '[2001:DB8::1]:7701'], nickname: 'Ana' });
    expect(saved).toEqual({
      id: 'id-1',
      name: 'Casa do Zé',
      addresses: ['casa.example.com:7700', '[2001:db8::1]:7701'],
      serverKeyId: KEY_A,
      nickname: 'Ana',
      addedAt: 1_001,
    });
    expect(SavedServersStore.load(dir.path).list()).toEqual([saved]);
  });

  it('keeps one entry per serverKeyId: same id and addedAt, newest addresses first, at most 8', () => {
    const s = store();
    const first = s.upsert({ serverKeyId: KEY_A, name: 'A', addresses: ['10.0.0.1', '10.0.0.2'], nickname: 'Ana' });
    const again = s.upsert({
      serverKeyId: KEY_A,
      name: 'A renamed',
      addresses: ['10.0.0.9', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6', '10.0.0.7', '10.0.0.8'],
      nickname: 'Ana 2',
    });
    expect(again.id).toBe(first.id);
    expect(again.addedAt).toBe(first.addedAt);
    expect(again.name).toBe('A renamed');
    expect(again.nickname).toBe('Ana 2');
    expect(again.addresses).toEqual([
      '10.0.0.9:7700', '10.0.0.2:7700', '10.0.0.3:7700', '10.0.0.4:7700',
      '10.0.0.5:7700', '10.0.0.6:7700', '10.0.0.7:7700', '10.0.0.8:7700',
    ]);
    expect(s.list()).toHaveLength(1);
  });

  it('looks servers up by id and by serverKeyId', () => {
    const s = store();
    const a = s.upsert({ serverKeyId: KEY_A, name: 'A', addresses: ['10.0.0.1'], nickname: 'x' });
    const b = s.upsert({ serverKeyId: KEY_B, name: 'B', addresses: ['10.0.0.2'], nickname: 'x' });
    expect(s.get(b.id)).toEqual(b);
    expect(s.findByServerKeyId(KEY_A)).toEqual(a);
    expect(s.get('nope')).toBeUndefined();
    expect(s.findByServerKeyId(toBase64Url(new Uint8Array(32)))).toBeUndefined();
  });

  it('falls back to the first address when the name has nothing visible', () => {
    expect(store().upsert({ serverKeyId: KEY_A, name: '\u200B', addresses: ['10.0.0.1:7710'], nickname: 'x' }).name).toBe('10.0.0.1:7710');
  });

  it('rejects invalid input and saves nothing', () => {
    const s = store();
    expectBadRequest(() => s.upsert({ serverKeyId: KEY_A, name: 'A', addresses: ['bad host'], nickname: 'x' }));
    expectBadRequest(() => s.upsert({ serverKeyId: KEY_A, name: 'A', addresses: [], nickname: 'x' }));
    expectBadRequest(() => s.upsert({ serverKeyId: 'short', name: 'A', addresses: ['10.0.0.1'], nickname: 'x' }));
    expect(s.list()).toEqual([]);
    expect(existsSync(join(dir.path, SERVERS_FILE))).toBe(false);
  });

  it('removes by id and reports unknown ids', () => {
    const s = store();
    const a = s.upsert({ serverKeyId: KEY_A, name: 'A', addresses: ['10.0.0.1'], nickname: 'x' });
    expect(s.remove(a.id)).toBe(true);
    expect(s.remove(a.id)).toBe(false);
    expect(SavedServersStore.load(dir.path).list()).toEqual([]);
  });

  it("keeps each server's notification mode, writing down only what is not the default (v0.4.2)", () => {
    const s = store();
    const a = s.upsert({ serverKeyId: KEY_A, name: 'A', addresses: ['10.0.0.1'], nickname: 'x' });
    expect(a.notify).toBeUndefined(); // "Só @menções"
    expect(s.setNotify(a.id, 'mentions')).toBe(false);
    expect(s.setNotify(a.id, 'all')).toBe(true);
    expect(s.setNotify(a.id, 'all')).toBe(false);
    expect(s.setNotify('nope', 'none')).toBe(false);
    // A later join of the same server keeps it, like the icon.
    s.setIcon(a.id, 'ab'.repeat(32));
    expect(s.upsert({ serverKeyId: KEY_A, name: 'A', addresses: ['10.0.0.2'], nickname: 'x' })).toMatchObject({ notify: 'all', iconHash: 'ab'.repeat(32) });
    expect(SavedServersStore.load(dir.path).get(a.id)?.notify).toBe('all');
    expect(s.setNotify(a.id, 'mentions')).toBe(true);
    expect(JSON.parse(readFileSync(join(dir.path, SERVERS_FILE), 'utf8')).servers[0]).not.toHaveProperty('notify');
  });

  it("keeps each text channel's mode, mute and pin, dropping what is the default and mutes already over (v0.5.0)", () => {
    const C1 = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';
    const C2 = 'BBBBBBBBBBBBBBBBBBBBBBBBBB';
    let now = 1_000;
    const s = SavedServersStore.load(dir.path, { now: () => now, newId: () => 'id-1' });
    const a = s.upsert({ serverKeyId: KEY_A, name: 'A', addresses: ['10.0.0.1'], nickname: 'x' });
    expect(s.setChannel(a.id, C1, { notify: 'all', mutedUntil: 5_000 })).toBe(true);
    expect(s.setChannel(a.id, C1, { notify: 'all' })).toBe(false);
    expect(s.setChannel(a.id, C2, { mutedUntil: null, pinned: true })).toBe(true);
    expect(s.setChannel(a.id, C1, { pinned: true })).toBe(true);
    expect(s.setChannel(a.id, C2, { pinned: true })).toBe(false); // already pinned: it keeps its place
    expect(s.setChannel('nope', C1, { pinned: true })).toBe(false);
    expect(s.get(a.id)).toMatchObject({ channels: { [C1]: { notify: 'all', mutedUntil: 5_000 }, [C2]: { mutedUntil: null } }, pinned: [C2, C1] });
    // A later join keeps them, and so does the file.
    s.upsert({ serverKeyId: KEY_A, name: 'A', addresses: ['10.0.0.2'], nickname: 'x' });
    expect(SavedServersStore.load(dir.path).get(a.id)).toMatchObject({ channels: { [C2]: { mutedUntil: null } }, pinned: [C2, C1] });
    // Once its time passed, a timed mute is dropped with the next write; back to defaults, nothing is left.
    now = 6_000;
    expect(s.setChannel(a.id, C1, { notify: null, pinned: false })).toBe(true);
    expect(s.get(a.id)).toMatchObject({ channels: { [C2]: { mutedUntil: null } }, pinned: [C2] });
    expect(s.setChannel(a.id, C2, { mutedUntil: false, pinned: false })).toBe(true);
    const written = JSON.parse(readFileSync(join(dir.path, SERVERS_FILE), 'utf8')).servers[0];
    expect(written).not.toHaveProperty('channels');
    expect(written).not.toHaveProperty('pinned');
    expectBadRequest(() => s.setChannel(a.id, '__proto__', { pinned: true }));
  });

  it('reads damaged channel choices as none, keeping the server', () => {
    writeFileSync(
      join(dir.path, SERVERS_FILE),
      JSON.stringify({
        version: 1,
        servers: [{ id: 'x', name: 'A', addresses: ['10.0.0.1:7700'], serverKeyId: KEY_A, nickname: 'x', addedAt: 1, channels: { nope: { notify: 'all' } }, pinned: 'C1' }],
      }),
    );
    const saved = store().get('x');
    expect(saved).toMatchObject({ id: 'x', name: 'A' });
    expect(saved?.channels).toBeUndefined();
    expect(saved?.pinned).toBeUndefined();
  });

  it("reads an unknown notification mode (a newer app's) as the default, keeping the server", () => {
    writeFileSync(
      join(dir.path, SERVERS_FILE),
      JSON.stringify({ version: 1, servers: [{ id: 'x', name: 'A', addresses: ['10.0.0.1:7700'], serverKeyId: KEY_A, nickname: 'x', addedAt: 1, notify: 'loud' }] }),
    );
    expect(store().get('x')?.notify).toBeUndefined();
  });

  it('hands out copies, not its internal state', () => {
    const s = store();
    s.upsert({ serverKeyId: KEY_A, name: 'A', addresses: ['10.0.0.1'], nickname: 'x' });
    s.list()[0]!.addresses.push('evil:1');
    expect(s.list()[0]!.addresses).toEqual(['10.0.0.1:7700']);
  });

  it('recovers from a corrupt file with an empty list and keeps the broken copy', () => {
    writeFileSync(join(dir.path, SERVERS_FILE), JSON.stringify({ version: 1, servers: [{ id: 'x' }] }));
    expect(store().list()).toEqual([]);
    expect(readdirSync(dir.path).some((f) => f.startsWith(`${SERVERS_FILE}.corrupt-`))).toBe(true);
  });
});
