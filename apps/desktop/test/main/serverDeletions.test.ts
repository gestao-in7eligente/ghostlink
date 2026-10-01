// The owner's app erases what is left of a deleted server (leave/delete spec §3, §4): the Railway
// project of a server it created, only after the deadline or SERVER_DELETED, never after a restore.
// Railway is the fake (test/helpers/fakeRailway.ts); nothing here reaches the real API.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RAILWAY_FILE, RailwayStore, type ManagedServer } from '../../src/main/railway/store.js';
import { ServerDeletions, railwayDeletionDecision } from '../../src/main/serverDeletions.js';
import { FakeRailway, captureLog, data, gqlError } from '../helpers/fakeRailway.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir('ghostlink-server-deletions-');
const HOUR = 3_600_000;
const START = Date.UTC(2026, 9, 1, 12);
const KEY = 'K'.repeat(43);

const record = (extra: Partial<ManagedServer> = {}): ManagedServer => ({
  projectId: 'proj-1',
  environmentId: 'env-1',
  serviceId: 'svc-1',
  volumeId: 'vol-1',
  address: 'tropa.proxy.rlwy.net:25889',
  serverKeyId: KEY,
  region: 'us-east4-eqdc4a',
  createdAt: START - 24 * HOUR,
  ...extra,
});

let clock: number;
let railway: FakeRailway;
let token: string | null;
let store: RailwayStore;
let forgotten: string[];
let host: { markDeleting: ReturnType<typeof vi.fn>; eraseIfDue: ReturnType<typeof vi.fn> };
let deletions: ServerDeletions;

function managedOnDisk(): Record<string, unknown>[] {
  return (JSON.parse(readFileSync(join(dir.path, RAILWAY_FILE), 'utf8')) as { managed: Record<string, unknown>[] }).managed;
}

beforeEach(() => {
  clock = START;
  token = 'account-token';
  railway = new FakeRailway().on('ProjectDelete', data({ projectDelete: true }));
  writeFileSync(join(dir.path, RAILWAY_FILE), JSON.stringify({ version: 1, pending: null, managed: [record()] }));
  store = RailwayStore.load(dir.path);
  forgotten = [];
  host = { markDeleting: vi.fn(() => false), eraseIfDue: vi.fn(async () => null) };
  deletions = new ServerDeletions({
    railway: store,
    token: () => token,
    fetch: railway.fetch,
    host,
    forget: async (serverKeyId) => {
      forgotten.push(serverKeyId);
    },
    log: captureLog(),
    now: () => clock,
    sleep: async () => {},
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
  });
});

describe('railwayDeletionDecision (spec §4)', () => {
  it('waits before the deadline, deletes after it, and keeps a server never deleted or restored', () => {
    expect(railwayDeletionDecision({ deletingAt: START + HOUR }, START, false)).toBe('wait');
    expect(railwayDeletionDecision({ deletingAt: START + HOUR }, START + HOUR - 1, false)).toBe('wait');
    expect(railwayDeletionDecision({ deletingAt: START + HOUR }, START + HOUR, false)).toBe('delete');
    expect(railwayDeletionDecision({}, START + 100 * HOUR, false)).toBe('keep');
  });

  it('deletes once the server itself answered SERVER_DELETED', () => {
    expect(railwayDeletionDecision({ deletingAt: START + HOUR }, START, true)).toBe('delete');
    expect(railwayDeletionDecision({}, START, true)).toBe('delete');
  });
});

describe('ServerDeletions: the Railway project', () => {
  it('records the deadline from server.deleting in railway.json and the hosted record, and never deletes before it', async () => {
    deletions.observe({ kind: 'deleting', serverKeyId: KEY, at: START + 48 * HOUR });
    expect(managedOnDisk()[0]!.deletingAt).toBe(START + 48 * HOUR);
    expect(host.markDeleting).toHaveBeenCalledWith(KEY, START + 48 * HOUR);

    clock = START + 48 * HOUR - 1;
    await deletions.sweepNow();
    expect(railway.ops()).toEqual([]);
    expect(store.managed).toHaveLength(1);
    expect(forgotten).toEqual([]);
  });

  it('after the deadline: deletes the project, forgets the managed record and the saved server', async () => {
    deletions.observe({ kind: 'deleting', serverKeyId: KEY, at: START + 48 * HOUR });
    clock = START + 48 * HOUR;
    await deletions.sweepNow();
    expect(railway.ops()).toEqual(['ProjectDelete']);
    expect(railway.variables('ProjectDelete')).toEqual([{ id: 'proj-1' }]);
    expect(railway.calls[0]!.auth).toBe('Bearer account-token');
    expect(store.managed).toEqual([]);
    expect(managedOnDisk()).toEqual([]);
    expect(forgotten).toEqual([KEY]);
  });

  it('a restore clears the record: never deleted, even long after the old deadline', async () => {
    deletions.observe({ kind: 'deleting', serverKeyId: KEY, at: START + 48 * HOUR });
    deletions.observe({ kind: 'restored', serverKeyId: KEY });
    expect(managedOnDisk()[0]).not.toHaveProperty('deletingAt');
    expect(host.markDeleting).toHaveBeenLastCalledWith(KEY, null);
    clock = START + 100 * HOUR;
    await deletions.sweepNow();
    expect(railway.ops()).toEqual([]);
    expect(store.managed).toHaveLength(1);
  });

  it('SERVER_DELETED from the server deletes at once, even without a local record', async () => {
    deletions.observe({ kind: 'deleted', serverKeyId: KEY });
    await deletions.sweepNow();
    expect(railway.ops()).toEqual(['ProjectDelete']);
    expect(store.managed).toEqual([]);
  });

  it('a server this app did not create is never touched', async () => {
    deletions.observe({ kind: 'deleting', serverKeyId: 'X'.repeat(43), at: START });
    deletions.observe({ kind: 'deleted', serverKeyId: 'Y'.repeat(43) });
    clock = START + 100 * HOUR;
    await deletions.sweepNow();
    expect(railway.ops()).toEqual([]);
    expect(store.managed).toHaveLength(1);
  });

  it('keeps the record for the next sweep without a token, or when Railway fails', async () => {
    deletions.observe({ kind: 'deleting', serverKeyId: KEY, at: START });
    token = null;
    await deletions.sweepNow();
    expect(railway.ops()).toEqual([]);
    expect(store.managed).toHaveLength(1);

    token = 'account-token';
    railway.on('ProjectDelete', { status: 500 });
    await deletions.sweepNow();
    expect(store.managed).toHaveLength(1);
    expect(forgotten).toEqual([]);

    railway.on('ProjectDelete', data({ projectDelete: true }));
    await deletions.sweepNow();
    expect(store.managed).toEqual([]);
  });

  it('a project already gone on Railway counts as deleted', async () => {
    railway.on('ProjectDelete', gqlError('Project not found'));
    deletions.observe({ kind: 'deleting', serverKeyId: KEY, at: START });
    await deletions.sweepNow();
    expect(store.managed).toEqual([]);
    expect(forgotten).toEqual([KEY]);
  });
});

describe('ServerDeletions: the server hosted here', () => {
  it('asks the Host mode to erase a due server and forgets it', async () => {
    host.eraseIfDue.mockResolvedValueOnce(KEY);
    await deletions.sweepNow();
    expect(host.eraseIfDue).toHaveBeenCalledWith(START, expect.any(Set));
    expect(forgotten).toEqual([KEY]);
  });

  it('start() sweeps at once, then every 30 min', async () => {
    const scheduled: number[] = [];
    const timed = new ServerDeletions({
      railway: store,
      token: () => token,
      fetch: railway.fetch,
      host,
      forget: async () => {},
      log: captureLog(),
      now: () => clock,
      timers: { setTimeout: (_fn, ms) => scheduled.push(ms), clearTimeout: () => {} },
    });
    timed.start();
    await vi.waitFor(() => expect(scheduled).toEqual([30 * 60_000]));
    expect(host.eraseIfDue).toHaveBeenCalledTimes(1);
    timed.dispose();
  });
});
