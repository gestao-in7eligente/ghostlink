// Servers follow the app's version (spec 2026-10-01 §3): the decision to update a Railway server
// the app created, and the Railway calls that update it. Fakes only: Railway's API (the
// provisioner tests' FakeRailway), /health and /owner/status, the timers and the clock.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from '@ghostlink/shared';
import type { ManagedServerUpdate } from '../../src/shared/serverUpdateTypes.js';
import { railwayImage } from '../../src/main/railway/image.js';
import type { OwnerStatus, ServerHealth } from '../../src/main/railway/serverStatus.js';
import { SERVER_UPDATE_TIMING, ServerUpdates, type ServerUpdatesDeps, type Timers } from '../../src/main/railway/serverUpdates.js';
import { RAILWAY_FILE, RailwayStore } from '../../src/main/railway/store.js';
import { FakeRailway, captureLog, data, gqlError } from '../helpers/fakeRailway.js';
import { useTempDir } from '../helpers/tempDir.js';

const TOKEN = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const APP = '0.2.2';
const IMAGE = railwayImage({ version: APP, packaged: true, env: {} });
const KEY_ID = toBase64Url(new Uint8Array(32).fill(7));
const OTHER_KEY_ID = toBase64Url(new Uint8Array(32).fill(9));
const MIN = 60_000;
const HOUR = 60 * MIN;
const START = Date.UTC(2026, 9, 1, 12, 0, 0);

function record(serverKeyId = KEY_ID, extra: Record<string, unknown> = {}) {
  const n = serverKeyId === KEY_ID ? 1 : 2;
  return {
    projectId: `proj-${n}`,
    environmentId: `env-${n}`,
    serviceId: `svc-${n}`,
    volumeId: `vol-${n}`,
    address: `roundhouse${n}.proxy.rlwy.net:1514${n}`,
    serverKeyId,
    region: 'us-east4-eqdc4a',
    createdAt: 1_000,
    ...extra,
  };
}

class FakeTimers implements Timers {
  pending: { fn: () => void; ms: number; id: number }[] = [];
  #next = 1;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.#next++;
    this.pending.push({ fn, ms, id });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    this.pending = this.pending.filter((t) => t.id !== handle);
  };
  /** Runs the next timer, as if its time had come. */
  fire(): void {
    const timer = this.pending.shift();
    if (!timer) throw new Error('no timer is pending');
    clock += timer.ms;
    timer.fn();
  }
}

const dir = useTempDir('ghostlink-server-updates-');

let clock: number;
let railway: FakeRailway;
let token: string | null;
/** What each server's /health answers, by address. */
let running: Map<string, string>;
let voiceActive: boolean;
let events: ManagedServerUpdate[];
let timers: FakeTimers;
let log: ReturnType<typeof captureLog>;
let health: ReturnType<typeof vi.fn<(server: { address: string; serverKeyId: string }) => Promise<ServerHealth>>>;
let ownerStatus: ReturnType<typeof vi.fn<(server: { address: string; serverKeyId: string }, key: { sign(m: Uint8Array): Uint8Array }) => Promise<OwnerStatus>>>;
const signer = { sign: () => new Uint8Array(64) };
let serverKey: ReturnType<typeof vi.fn<(serverKeyId: string) => typeof signer>>;

/** A deploy that succeeds on the second poll; the server answers the new version from then on. */
function updatingRailway(address = record().address): FakeRailway {
  return new FakeRailway()
    .on('ServiceInstanceUpdate', data({ serviceInstanceUpdate: true }))
    .on('ServiceInstance', data({ serviceInstance: { id: 'si-1', latestDeployment: { id: 'dep-1', status: 'SUCCESS', createdAt: '2026-09-29T12:00:00Z' } } }))
    .on('ServiceInstanceDeployV2', data({ serviceInstanceDeployV2: 'dep-2' }))
    .on('Deployment', data({ deployment: { id: 'dep-2', status: 'BUILDING' } }), () => {
      running.set(address, APP);
      return data({ deployment: { id: 'dep-2', status: 'SUCCESS' } });
    });
}

function writeManaged(...managed: ReturnType<typeof record>[]): void {
  writeFileSync(join(dir.path, RAILWAY_FILE), JSON.stringify({ version: 1, pending: null, managed }));
}

function managedOnDisk(): Record<string, unknown>[] {
  return (JSON.parse(readFileSync(join(dir.path, RAILWAY_FILE), 'utf8')) as { managed: Record<string, unknown>[] }).managed;
}

function updates(extra: Partial<ServerUpdatesDeps> = {}): ServerUpdates {
  return new ServerUpdates({
    store: RailwayStore.load(dir.path),
    token: () => token,
    fetch: railway.fetch,
    appVersion: APP,
    image: IMAGE,
    serverKey,
    emit: (u) => events.push(u),
    health,
    ownerStatus,
    log,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    timers,
    ...extra,
  });
}

/** start() and wait for the first check to finish. */
async function started(extra: Partial<ServerUpdatesDeps> = {}): Promise<ServerUpdates> {
  const u = updates(extra);
  u.start();
  await u.settled();
  return u;
}

const UPDATE_OPS = ['ServiceInstanceUpdate', 'ServiceInstance', 'ServiceInstanceDeployV2', 'Deployment', 'Deployment'];

beforeEach(() => {
  clock = START;
  railway = updatingRailway();
  token = TOKEN;
  running = new Map([[record().address, '0.2.1']]);
  voiceActive = false;
  events = [];
  timers = new FakeTimers();
  log = captureLog();
  health = vi.fn(async (server) => {
    const version = running.get(server.address);
    if (version === undefined) throw Object.assign(new Error('UNREACHABLE'), { code: 'UNREACHABLE' });
    return { version };
  });
  ownerStatus = vi.fn(async (server) => ({ version: running.get(server.address)!, voiceActive }));
  serverKey = vi.fn(() => signer);
  writeManaged(record());
});

describe('the decision (spec §3 steps 1–3)', () => {
  it('same version: nothing to do, no Railway call, the next check in 30 min', async () => {
    running.set(record().address, APP);
    const u = await started();
    expect(railway.calls).toEqual([]);
    expect(ownerStatus).not.toHaveBeenCalled();
    expect(u.state(KEY_ID)).toEqual({ serverKeyId: KEY_ID, version: APP, target: APP, state: 'current' });
    expect(managedOnDisk()[0]).not.toHaveProperty('outdatedSince');
    expect(timers.pending.map((t) => t.ms)).toEqual([30 * MIN]);
  });

  it('a newer server is left alone, and a stale outdatedSince is cleared', async () => {
    writeManaged(record(KEY_ID, { outdatedSince: START - HOUR }));
    running.set(record().address, '0.3.0');
    const u = await started();
    expect(railway.calls).toEqual([]);
    expect(u.state(KEY_ID)?.state).toBe('current');
    expect(managedOnDisk()[0]).not.toHaveProperty('outdatedSince');
  });

  it('older and nobody in a call: updates to the app’s version at once', async () => {
    const u = await started();
    expect(ownerStatus).toHaveBeenCalledWith(expect.objectContaining({ address: record().address, serverKeyId: KEY_ID }), signer);
    expect(serverKey).toHaveBeenCalledWith(KEY_ID);
    expect(railway.ops()).toEqual(UPDATE_OPS);
    expect(events.map((e) => [e.state, e.version])).toEqual([
      ['updating', '0.2.1'],
      ['current', APP],
    ]);
    expect(u.state(KEY_ID)).toEqual({ serverKeyId: KEY_ID, version: APP, target: APP, state: 'current' });
    expect(managedOnDisk()[0]).not.toHaveProperty('outdatedSince');
  });

  it('older with someone in a call: waits, remembers since when, and asks again in 10 min', async () => {
    voiceActive = true;
    const u = await started();
    expect(railway.calls).toEqual([]);
    expect(u.state(KEY_ID)).toEqual({ serverKeyId: KEY_ID, version: '0.2.1', target: APP, state: 'waiting' });
    expect(managedOnDisk()[0]!.outdatedSince).toBe(START);
    expect(timers.pending.map((t) => t.ms)).toEqual([10 * MIN]);

    // Still in a call 10 min later: since when stays the first time it was seen behind.
    timers.fire();
    await u.settled();
    expect(railway.calls).toEqual([]);
    expect(managedOnDisk()[0]!.outdatedSince).toBe(START);

    // The call ended: the next check updates.
    voiceActive = false;
    timers.fire();
    await u.settled();
    expect(railway.ops()).toEqual(UPDATE_OPS);
    expect(u.state(KEY_ID)?.state).toBe('current');
    expect(timers.pending.map((t) => t.ms)).toEqual([30 * MIN]);
  });

  it('24 h after it fell behind it updates even during a call, without asking', async () => {
    voiceActive = true;
    writeManaged(record(KEY_ID, { outdatedSince: START - 24 * HOUR }));
    const u = await started();
    expect(ownerStatus).not.toHaveBeenCalled();
    expect(railway.ops()).toEqual(UPDATE_OPS);
    expect(u.state(KEY_ID)?.state).toBe('current');
    expect(log.lines.join('\n')).toContain('behind for 24 h');
  });

  it('one minute before the 24 h it still waits for the call', async () => {
    voiceActive = true;
    writeManaged(record(KEY_ID, { outdatedSince: START - 24 * HOUR + MIN }));
    const u = await started();
    expect(railway.calls).toEqual([]);
    expect(u.state(KEY_ID)?.state).toBe('waiting');
  });

  it.each([
    ['refuses the signature (FORBIDDEN)', Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' })],
    ['has no /owner/status (an older server, NOT_FOUND)', Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })],
  ])('a server that %s counts as busy until the 24 h', async (_name, error) => {
    ownerStatus.mockRejectedValue(error);
    const u = await started();
    expect(railway.calls).toEqual([]);
    expect(u.state(KEY_ID)?.state).toBe('waiting');
  });

  it('a locked identity cannot ask, so it waits too', async () => {
    serverKey.mockImplementation(() => {
      throw Object.assign(new Error('IDENTITY_UNAVAILABLE'), { code: 'IDENTITY_UNAVAILABLE' });
    });
    const u = await started();
    expect(railway.calls).toEqual([]);
    expect(u.state(KEY_ID)?.state).toBe('waiting');
  });

  it('without the Railway token: no Railway call, and the page asks to connect it again', async () => {
    token = null;
    const u = await started();
    expect(railway.calls).toEqual([]);
    expect(ownerStatus).not.toHaveBeenCalled();
    expect(u.state(KEY_ID)).toEqual({ serverKeyId: KEY_ID, version: '0.2.1', target: APP, state: 'railwayDisconnected' });
    expect(managedOnDisk()[0]!.outdatedSince).toBe(START);
  });

  it('a server that does not answer /health is left alone', async () => {
    running.clear();
    const u = await started();
    expect(railway.calls).toEqual([]);
    expect(ownerStatus).not.toHaveBeenCalled();
    expect(u.state(KEY_ID)?.state).toBe('unknown');
    expect(timers.pending.map((t) => t.ms)).toEqual([30 * MIN]);
  });

  it('a version that is not a release is left alone', async () => {
    running.set(record().address, '0.2.1-dev');
    const u = await started();
    expect(railway.calls).toEqual([]);
    expect(u.state(KEY_ID)?.state).toBe('unknown');
  });

  it.each([
    ['0.2.10', '0.2.9', true],
    ['0.2.9', '0.2.10', false],
    ['0.10.0', '0.9.9', true],
    ['1.0.0', '0.99.99', true],
  ])('app %s with a server on %s updates it: %s', async (app, server, updated) => {
    running.set(record().address, server);
    railway = new FakeRailway()
      .on('ServiceInstanceUpdate', data({ serviceInstanceUpdate: true }))
      .on('ServiceInstance', data({ serviceInstance: { id: 'si-1', latestDeployment: null } }))
      .on('ServiceInstanceDeployV2', data({ serviceInstanceDeployV2: 'dep-2' }))
      .on('Deployment', () => {
        running.set(record().address, app);
        return data({ deployment: { id: 'dep-2', status: 'SUCCESS' } });
      });
    await started({ appVersion: app, image: railwayImage({ version: app, packaged: true, env: {} }) });
    expect(railway.calls.length > 0).toBe(updated);
    if (updated) expect(railway.variables('ServiceInstanceUpdate')[0]).toMatchObject({ input: { source: { image: `ghcr.io/gestao-in7eligente/ghostlink-server:${app}` } } });
  });
});

describe('the update (spec §3 steps 4–5, Railway calls)', () => {
  it('sets exactly the image of the app’s version, deploys, follows it to SUCCESS and confirms /health', async () => {
    await started();
    expect(railway.variables('ServiceInstanceUpdate')).toEqual([{ serviceId: 'svc-1', environmentId: 'env-1', input: { source: { image: IMAGE } } }]);
    expect(IMAGE).toBe(`ghcr.io/gestao-in7eligente/ghostlink-server:${APP}`);
    expect(railway.variables('ServiceInstance')).toEqual([{ serviceId: 'svc-1', environmentId: 'env-1' }]);
    expect(railway.variables('ServiceInstanceDeployV2')).toEqual([{ serviceId: 'svc-1', environmentId: 'env-1' }]);
    expect(railway.variables('Deployment')).toEqual([{ id: 'dep-2' }, { id: 'dep-2' }]);
    // Never the volume, the variables, the proxy or the project.
    for (const op of ['VariableCollectionUpsert', 'VolumeCreate', 'EnvironmentPatchCommit', 'ProjectDelete', 'ServiceCreate']) expect(railway.ops()).not.toContain(op);
    expect(railway.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    // /health once before and once after SUCCESS.
    expect(health).toHaveBeenCalledTimes(2);
  });

  it('follows a deployment already on its way instead of starting a second one', async () => {
    railway.on('ServiceInstance', data({ serviceInstance: { id: 'si-1', latestDeployment: { id: 'dep-auto', status: 'DEPLOYING' } } })).on('Deployment', () => {
      running.set(record().address, APP);
      return data({ deployment: { id: 'dep-auto', status: 'SUCCESS' } });
    });
    const u = await started();
    expect(railway.ops()).not.toContain('ServiceInstanceDeployV2');
    expect(railway.variables('Deployment')).toEqual([{ id: 'dep-auto' }]);
    expect(u.state(KEY_ID)?.state).toBe('current');
  });

  it('a deploy that fails is logged and tried again at the next check', async () => {
    railway
      .on('Deployment', data({ deployment: { id: 'dep-2', status: 'BUILDING' } }), data({ deployment: { id: 'dep-2', status: 'FAILED' } }))
      .on('BuildLogs', data({ buildLogs: [{ timestamp: null, message: 'pull access denied', severity: 'error' }] }))
      .on('DeploymentLogs', data({ deploymentLogs: [] }));
    const u = await started();
    expect(u.state(KEY_ID)).toEqual({ serverKeyId: KEY_ID, version: '0.2.1', target: APP, state: 'failed' });
    expect(managedOnDisk()[0]!.outdatedSince).toBe(START);
    expect(log.lines.join('\n')).toContain('pull access denied');
    expect(log.lines.join('\n')).toContain('RAILWAY_DEPLOY_FAILED');
    expect(timers.pending.map((t) => t.ms)).toEqual([30 * MIN]);

    railway.calls.length = 0;
    railway.on('Deployment', data({ deployment: { id: 'dep-2', status: 'BUILDING' } }), () => {
      running.set(record().address, APP);
      return data({ deployment: { id: 'dep-2', status: 'SUCCESS' } });
    });
    timers.fire();
    await u.settled();
    expect(railway.ops()).toEqual(UPDATE_OPS);
    expect(u.state(KEY_ID)?.state).toBe('current');
    expect(managedOnDisk()[0]).not.toHaveProperty('outdatedSince');
    expect(events.map((e) => e.state)).toEqual(['updating', 'failed', 'updating', 'current']);
  });

  it('a deploy that never ends gives up after 10 min', async () => {
    railway.on('Deployment', data({ deployment: { id: 'dep-2', status: 'DEPLOYING' } }));
    const u = await started();
    expect(u.state(KEY_ID)?.state).toBe('failed');
    expect(log.lines.join('\n')).toContain('RAILWAY_TIMEOUT');
    expect(clock - START).toBeGreaterThanOrEqual(SERVER_UPDATE_TIMING.deployTimeoutMs);
    expect(clock - START).toBeLessThan(SERVER_UPDATE_TIMING.deployTimeoutMs + 2 * SERVER_UPDATE_TIMING.pollMs);
  });

  it('SUCCESS is not enough: the server has to answer the new version', async () => {
    railway.on('Deployment', data({ deployment: { id: 'dep-2', status: 'SUCCESS' } })); // /health keeps answering 0.2.1
    const u = await started();
    expect(u.state(KEY_ID)?.state).toBe('failed');
    expect(managedOnDisk()[0]!.outdatedSince).toBe(START);
  });

  it('a token Railway refuses asks the page to connect Railway again', async () => {
    railway.on('ServiceInstanceUpdate', gqlError('Not Authorized'));
    const u = await started();
    expect(railway.ops()).toEqual(['ServiceInstanceUpdate']);
    expect(u.state(KEY_ID)?.state).toBe('railwayDisconnected');
  });

  it('never writes the token to the log', async () => {
    railway.on('ServiceInstanceUpdate', gqlError(`Not Authorized for ${TOKEN}`));
    await started();
    expect(log.lines.length).toBeGreaterThan(0);
    expect(log.lines.join('\n')).not.toContain(TOKEN);
  });
});

describe('"Atualizar agora" and the scope (spec §3, §5)', () => {
  it('skips the wait for the call and starts at once', async () => {
    voiceActive = true;
    const u = await started();
    expect(u.state(KEY_ID)?.state).toBe('waiting');
    ownerStatus.mockClear();
    expect(u.updateNow(KEY_ID)).toEqual({ serverKeyId: KEY_ID, version: '0.2.1', target: APP, state: 'updating' });
    await u.settled();
    expect(ownerStatus).not.toHaveBeenCalled();
    expect(railway.ops()).toEqual(UPDATE_OPS);
    expect(u.state(KEY_ID)?.state).toBe('current');
  });

  it('a second click while it updates changes nothing', async () => {
    const u = updates();
    expect(u.updateNow(KEY_ID).state).toBe('updating');
    expect(u.updateNow(KEY_ID).state).toBe('updating');
    await u.settled();
    expect(railway.ops()).toEqual(UPDATE_OPS);
  });

  it('a server already on the app’s version is not deployed again', async () => {
    running.set(record().address, APP);
    const u = updates();
    u.updateNow(KEY_ID);
    await u.settled();
    expect(railway.calls).toEqual([]);
    expect(u.state(KEY_ID)?.state).toBe('current');
  });

  it('refuses a server the app did not create, and works only with the token', () => {
    const u = updates();
    expect(() => u.updateNow(OTHER_KEY_ID)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    token = null;
    expect(() => u.updateNow(KEY_ID)).toThrow(expect.objectContaining({ code: 'RAILWAY_NOT_CONNECTED' }));
    expect(railway.calls).toEqual([]);
  });

  it('only the servers in railway.json have a state', async () => {
    const u = updates();
    expect(u.state(OTHER_KEY_ID)).toBeNull();
    expect(u.state(KEY_ID)).toEqual({ serverKeyId: KEY_ID, version: null, target: APP, state: 'unknown' });
  });

  it('checks every managed server, each with its own service', async () => {
    writeManaged(record(KEY_ID), record(OTHER_KEY_ID));
    running.set(record(OTHER_KEY_ID).address, '0.2.0');
    railway = new FakeRailway()
      .on('ServiceInstanceUpdate', data({ serviceInstanceUpdate: true }))
      .on('ServiceInstance', data({ serviceInstance: { id: 'si', latestDeployment: null } }))
      .on('ServiceInstanceDeployV2', (v) => data({ serviceInstanceDeployV2: `dep-${String(v.serviceId)}` }))
      .on('Deployment', (v) => {
        running.set(record(v.id === 'dep-svc-1' ? KEY_ID : OTHER_KEY_ID).address, APP);
        return data({ deployment: { id: v.id, status: 'SUCCESS' } });
      });
    const u = await started();
    expect(railway.variables('ServiceInstanceUpdate')).toEqual([
      { serviceId: 'svc-1', environmentId: 'env-1', input: { source: { image: IMAGE } } },
      { serviceId: 'svc-2', environmentId: 'env-2', input: { source: { image: IMAGE } } },
    ]);
    expect(u.state(KEY_ID)?.state).toBe('current');
    expect(u.state(OTHER_KEY_ID)?.state).toBe('current');
  });

  it('dispose stops the checks', async () => {
    const u = await started();
    expect(timers.pending).toHaveLength(1);
    u.dispose();
    expect(timers.pending).toHaveLength(0);
  });

  it('nothing runs before start()', async () => {
    const u = updates();
    await u.settled();
    expect(health).not.toHaveBeenCalled();
    expect(timers.pending).toHaveLength(0);
  });
});
