import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatWithOptions } from 'node:util';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { formatFingerprint, toBase64Url } from '@ghostlink/shared';
import { AppError } from '../../src/shared/appErrors.js';
import type { JoinConnectRequest, ProbeResult, RendererWelcome } from '../../src/shared/ipcTypes.js';
import { RAILWAY_STEPS, type RailwayProgress } from '../../src/shared/railwayTypes.js';
import type { FetchInit, FetchResponse } from '../../src/main/railway/api.js';
import { RailwayProvisioner, type RailwayProvisionerDeps } from '../../src/main/railway/provisioner.js';
import { RAILWAY_FILE } from '../../src/main/railway/store.js';
import { RAILWAY_TOKEN_FILE } from '../../src/main/railway/token.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';
import { useTempDir } from '../helpers/tempDir.js';

const TOKEN = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const IMAGE = 'ghcr.io/gestao-in7eligente/ghostlink-server:0.2.0';
const KEY_ID = toBase64Url(new Uint8Array(32).fill(7));
const OTHER_KEY_ID = toBase64Url(new Uint8Array(32).fill(9));
const SETUP = '3f9a2b1c-7d4e5f60-a1b2c3d4-e5f60718';
const ADDRESS = 'roundhouse.proxy.rlwy.net:15140';
const REQUEST = { workspaceId: 'ws-1', name: 'Casa do Zé', region: 'us-east4-eqdc4a', nickname: 'Zé' } as const;
const WELCOME = { serverId: 'saved-1', address: ADDRESS, sessionId: 'sess' } as unknown as RendererWelcome;
const PROXY = { id: 'tcp-1', domain: 'roundhouse.proxy.rlwy.net', proxyPort: 15140, applicationPort: 7700, syncStatus: 'ACTIVE', deletedAt: null };
const START_LINES = [
  { timestamp: '2026-09-29T12:00:00.000Z', message: 'GhostLink server 0.2.0', severity: 'info' },
  { timestamp: '2026-09-29T12:00:00.100Z', message: `Fingerprint: ${formatFingerprint(KEY_ID)}`, severity: 'info' },
  { timestamp: '2026-09-29T12:00:00.200Z', message: `Setup code (use it once to become the owner): ${SETUP}`, severity: 'info' },
];

type Reply = { data: unknown } | { errors: { message: string }[] } | { status: number; headers?: Record<string, string> } | Error | Promise<never>;
type Responder = Reply | ((variables: Record<string, unknown>) => Reply | Promise<Reply>);

/**
 * Railway's API as far as the provisioner uses it: per operation, the replies given to the
 * latest on() in order (the last one repeats).
 */
class FakeRailway {
  readonly calls: { op: string; variables: Record<string, unknown>; auth: string | undefined }[] = [];
  readonly #replies = new Map<string, Responder[]>();
  readonly #served = new Map<string, number>();

  on(op: string, ...replies: Responder[]): this {
    this.#replies.set(op, replies);
    this.#served.set(op, 0);
    return this;
  }

  ops(): string[] {
    return this.calls.map((c) => c.op);
  }

  variables(op: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.op === op).map((c) => c.variables);
  }

  readonly fetch = async (_url: string, init: FetchInit): Promise<FetchResponse> => {
    const body = JSON.parse(init.body) as { operationName: string; variables: Record<string, unknown> };
    const op = body.operationName;
    this.calls.push({ op, variables: body.variables, auth: init.headers.authorization });
    const replies = this.#replies.get(op);
    if (!replies) throw new Error(`unexpected ${op}`);
    const served = this.#served.get(op) ?? 0;
    this.#served.set(op, served + 1);
    const responder = replies[Math.min(served, replies.length - 1)]!;
    const reply = await (typeof responder === 'function' ? responder(body.variables) : responder);
    if (reply instanceof Error) throw reply;
    const status = 'status' in reply ? reply.status : 200;
    const headers = new Map(Object.entries('headers' in reply ? (reply.headers ?? {}) : {}));
    return { status, headers: { get: (n) => headers.get(n) ?? null }, text: async () => JSON.stringify('status' in reply ? {} : reply) };
  };
}

const data = (d: unknown) => ({ data: d });
const gqlError = (message: string) => ({ errors: [{ message }] });

function happyRailway(): FakeRailway {
  return new FakeRailway()
    .on('ApiTokenContext', data({ apiToken: { workspaces: [{ id: 'ws-1', name: 'Pessoal' }] } }))
    .on('WorkspaceBilling', data({ workspace: { id: 'ws-1', plan: 'HOBBY', customer: { isTrialing: false } } }))
    .on(
      'ProjectCreate',
      data({
        projectCreate: {
          id: 'proj-1',
          name: 'ghostlink-casa-do-ze',
          workspaceId: 'ws-1',
          baseEnvironmentId: null,
          primaryEnvironmentId: 'env-1',
          environments: { edges: [{ node: { id: 'env-1', name: 'production' } }] },
        },
      }),
    )
    .on('ServiceCreate', data({ serviceCreate: { id: 'svc-1', name: 'ghostlink' } }))
    .on('ServiceInstanceUpdate', data({ serviceInstanceUpdate: true }))
    .on('VolumeCreate', data({ volumeCreate: { id: 'vol-1', name: 'ghostlink-volume' } }))
    .on('TcpProxies', data({ tcpProxies: [] }), data({ tcpProxies: [{ ...PROXY, syncStatus: 'CREATING' }] }), data({ tcpProxies: [PROXY] }))
    .on('EnvironmentPatchCommit', data({ environmentPatchCommit: 'commit-1' }))
    .on('VariableCollectionUpsert', data({ variableCollectionUpsert: true }))
    .on('Domains', data({ domains: { serviceDomains: [{ id: 'dom-1', domain: 'x.up.railway.app', targetPort: 8080 }], customDomains: [] } }))
    .on('ServiceDomainDelete', data({ serviceDomainDelete: true }))
    .on('ServiceInstance', data({ serviceInstance: { id: 'si-1', latestDeployment: null } }))
    .on('ServiceInstanceDeployV2', data({ serviceInstanceDeployV2: 'dep-1' }))
    .on('Deployment', data({ deployment: { id: 'dep-1', status: 'BUILDING' } }), data({ deployment: { id: 'dep-1', status: 'SUCCESS' } }))
    .on('DeploymentLogs', data({ deploymentLogs: [START_LINES[0]] }), data({ deploymentLogs: START_LINES }));
}

function captureLog() {
  const lines: string[] = [];
  const write = (level: string) => (message: string, ...details: unknown[]) => void lines.push(`${level} ${formatWithOptions({ colors: false }, message, ...details)}`);
  return { lines, info: write('info'), warn: write('warn'), error: write('error') };
}

const dir = useTempDir('ghostlink-railway-');

let railway: FakeRailway;
let safe: FakeSafeStorage;
let progress: RailwayProgress[];
let clock: number;
let log: ReturnType<typeof captureLog>;
let probe: Mock<(address: string) => Promise<ProbeResult>>;
let joinServer: Mock<(req: JoinConnectRequest) => Promise<RendererWelcome>>;

function provisioner(extra: Partial<RailwayProvisionerDeps> = {}): RailwayProvisioner {
  return new RailwayProvisioner({
    userDataDir: dir.path,
    safeStorage: safe,
    fetch: railway.fetch,
    image: IMAGE,
    probe,
    join: joinServer,
    emit: (p) => progress.push(p),
    log,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    ...extra,
  });
}

/** A provisioner with the token already connected; Railway's call log starts empty. */
async function connected(): Promise<RailwayProvisioner> {
  const p = provisioner();
  await p.connect(TOKEN);
  railway.calls.length = 0;
  return p;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'resolved',
    (e: { code?: string }) => e.code ?? 'no code',
  );
}

function railwayFile(): { pending: Record<string, unknown> | null; managed: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(join(dir.path, RAILWAY_FILE), 'utf8')) as never;
}

function everythingWritten(): string {
  const files = [RAILWAY_FILE, RAILWAY_TOKEN_FILE].filter((f) => existsSync(join(dir.path, f)));
  return files.map((f) => readFileSync(join(dir.path, f)).toString('latin1')).join('\n');
}

beforeEach(() => {
  railway = happyRailway();
  safe = new FakeSafeStorage();
  progress = [];
  clock = 1_000_000;
  log = captureLog();
  probe = vi.fn(async () => ({ serverKeyId: KEY_ID, fingerprint: formatFingerprint(KEY_ID) }));
  joinServer = vi.fn(async () => WELCOME);
});

describe('railway token (connect, status, disconnect)', () => {
  it('validates the token, maps the plans and stores it encrypted', async () => {
    railway
      .on('ApiTokenContext', data({ apiToken: { workspaces: [{ id: 'ws-1', name: 'Pessoal' }, { id: 'ws-2', name: 'Trial' }, { id: 'ws-3', name: 'Time' }] } }))
      .on('WorkspaceBilling', (v) =>
        v.workspaceId === 'ws-1'
          ? data({ workspace: { id: 'ws-1', plan: 'HOBBY', customer: { isTrialing: false } } })
          : v.workspaceId === 'ws-2'
            ? data({ workspace: { id: 'ws-2', plan: 'FREE', customer: { isTrialing: true } } })
            : gqlError('Not Authorized'),
      );
    const p = provisioner();
    expect(await p.connect(`  ${TOKEN}\n`)).toEqual({
      connected: true,
      workspaces: [
        { id: 'ws-1', name: 'Pessoal', plan: 'HOBBY' },
        { id: 'ws-2', name: 'Trial', plan: 'TRIAL' },
        { id: 'ws-3', name: 'Time', plan: 'UNKNOWN' },
      ],
    });
    expect(railway.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(existsSync(join(dir.path, RAILWAY_TOKEN_FILE))).toBe(true);
    expect(everythingWritten()).not.toContain(TOKEN);
    // A new session reads the token back and asks Railway once; later calls use the cache.
    railway.calls.length = 0;
    const again = provisioner();
    expect((await again.status()).workspaces).toHaveLength(3);
    await again.status();
    expect(railway.ops().filter((op) => op === 'ApiTokenContext')).toHaveLength(1);
  });

  it('falls back to `me` (with its plans) when apiToken is refused', async () => {
    railway
      .on('ApiTokenContext', gqlError('Cannot query field "apiToken"'))
      .on('Me', data({ me: { workspaces: [{ id: 'ws-9', name: 'Conta', plan: 'FREE' }] } }))
      .on('WorkspaceBilling', gqlError('Not Authorized'));
    expect(await provisioner().connect(TOKEN)).toEqual({ connected: true, workspaces: [{ id: 'ws-9', name: 'Conta', plan: 'FREE' }] });
    expect(railway.ops()).toEqual(['ApiTokenContext', 'Me', 'WorkspaceBilling']);
  });

  it('refuses an invalid token and stores nothing', async () => {
    railway.on('ApiTokenContext', gqlError('Not Authorized')).on('Me', gqlError('Not Authorized'));
    const p = provisioner();
    expect(await codeOf(p.connect(TOKEN))).toBe('RAILWAY_TOKEN_INVALID');
    expect(existsSync(join(dir.path, RAILWAY_TOKEN_FILE))).toBe(false);
    expect(await p.status()).toEqual({ connected: false, workspaces: [] });
    // Not even sent to Railway: it cannot be a token.
    railway.calls.length = 0;
    expect(await codeOf(p.connect('two words'))).toBe('RAILWAY_TOKEN_INVALID');
    expect(await codeOf(p.connect('   '))).toBe('RAILWAY_TOKEN_INVALID');
    expect(railway.calls).toEqual([]);
  });

  it('fails with ENCRYPTION_UNAVAILABLE before asking Railway', async () => {
    safe.available = false;
    expect(await codeOf(provisioner().connect(TOKEN))).toBe('ENCRYPTION_UNAVAILABLE');
    expect(railway.calls).toEqual([]);
    expect(existsSync(join(dir.path, RAILWAY_TOKEN_FILE))).toBe(false);
  });

  it('keeps an old token when a new one is refused, and disconnect deletes it', async () => {
    const p = await connected();
    railway.on('ApiTokenContext', { status: 429 });
    expect(await codeOf(p.connect('another-token'))).toBe('RAILWAY_RATE_LIMITED');
    expect(new FakeSafeStorage().decryptString(readFileSync(join(dir.path, RAILWAY_TOKEN_FILE)))).toBe(TOKEN);
    expect(p.disconnect()).toEqual({ connected: false, workspaces: [] });
    expect(existsSync(join(dir.path, RAILWAY_TOKEN_FILE))).toBe(false);
    expect(await p.status()).toEqual({ connected: false, workspaces: [] });
  });
});

describe('railway.create (research §9)', () => {
  it('provisions in order, with exactly these variables, and joins as the owner', async () => {
    const p = await connected();
    expect(await p.create(REQUEST)).toBe(WELCOME);

    expect(railway.ops()).toEqual([
      'ProjectCreate',
      'ServiceCreate',
      'ServiceInstanceUpdate',
      'VolumeCreate',
      'TcpProxies',
      'EnvironmentPatchCommit',
      'TcpProxies',
      'TcpProxies',
      'VariableCollectionUpsert',
      'Domains',
      'ServiceDomainDelete',
      'ServiceInstanceUpdate',
      'ServiceInstance',
      'ServiceInstanceDeployV2',
      'Deployment',
      'Deployment',
      'DeploymentLogs',
      'DeploymentLogs',
    ]);
    expect(railway.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(railway.variables('ProjectCreate')).toEqual([
      { input: { name: 'ghostlink-casa-do-ze', description: 'Managed by GhostLink', workspaceId: 'ws-1', defaultEnvironmentName: 'production' } },
    ]);
    expect(railway.variables('ServiceCreate')).toEqual([{ input: { projectId: 'proj-1', environmentId: 'env-1', name: 'ghostlink' } }]);
    expect(railway.variables('ServiceInstanceUpdate')).toEqual([
      {
        serviceId: 'svc-1',
        environmentId: 'env-1',
        input: { region: 'us-east4-eqdc4a', numReplicas: 1, restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10, sleepApplication: false },
      },
      { serviceId: 'svc-1', environmentId: 'env-1', input: { source: { image: IMAGE } } },
    ]);
    expect(railway.variables('VolumeCreate')).toEqual([{ input: { projectId: 'proj-1', environmentId: 'env-1', serviceId: 'svc-1', mountPath: '/data' } }]);
    expect(railway.variables('EnvironmentPatchCommit')).toEqual([
      {
        environmentId: 'env-1',
        patch: { services: { 'svc-1': { networking: { tcpProxies: { '7700': {} } } } } },
        commitMessage: 'GhostLink: public TCP proxy for 7700',
        skipDeploys: true,
      },
    ]);
    expect(railway.variables('TcpProxies')[0]).toEqual({ environmentId: 'env-1', serviceId: 'svc-1' });
    expect(railway.variables('VariableCollectionUpsert')).toEqual([
      {
        input: {
          projectId: 'proj-1',
          environmentId: 'env-1',
          serviceId: 'svc-1',
          variables: { GHOSTLINK_NAME: 'Casa do Zé', GHOSTLINK_VOICE: '1', GHOSTLINK_PORT: '7700', PORT: '7700', GHOSTLINK_DATA: '/data' },
          replace: false,
          skipDeploys: true,
        },
      },
    ]);
    expect(railway.variables('ServiceDomainDelete')).toEqual([{ id: 'dom-1' }]);
    expect(railway.variables('ServiceInstanceDeployV2')).toEqual([{ serviceId: 'svc-1', environmentId: 'env-1' }]);
    expect(railway.variables('Deployment')).toEqual([{ id: 'dep-1' }, { id: 'dep-1' }]);
    expect(railway.variables('DeploymentLogs')[0]).toEqual({ deploymentId: 'dep-1', limit: 1000 });

    expect(probe).toHaveBeenCalledWith(ADDRESS);
    expect(joinServer).toHaveBeenCalledExactlyOnceWith({ addresses: [ADDRESS], serverKeyId: KEY_ID, setupCode: SETUP, nickname: 'Zé', name: 'Casa do Zé' });
    expect(progress).toEqual(RAILWAY_STEPS.flatMap((step) => [{ step, state: 'running' }, { step, state: 'done' }]));

    expect(p.pending()).toBeNull();
    expect(railwayFile()).toEqual({
      version: 1,
      pending: null,
      managed: [
        {
          projectId: 'proj-1',
          environmentId: 'env-1',
          serviceId: 'svc-1',
          volumeId: 'vol-1',
          address: ADDRESS,
          serverKeyId: KEY_ID,
          region: 'us-east4-eqdc4a',
          createdAt: 1_000_000,
        },
      ],
    });
    expect(p.managed()).toHaveLength(1);
    // The setup code and the token never reach the disk or the log.
    expect(everythingWritten()).not.toContain(SETUP);
    expect(everythingWritten()).not.toContain(TOKEN);
    expect(log.lines.join('\n')).not.toContain(SETUP);
    expect(log.lines.join('\n')).not.toContain(TOKEN);
  });

  it('writes the pending record after every step, without secrets', async () => {
    const snapshots: unknown[] = [];
    const p = provisioner({
      emit: (e) => {
        if (e.state === 'done' && e.step !== 'join') snapshots.push(railwayFile().pending);
      },
    });
    await p.connect(TOKEN);
    await p.create(REQUEST);
    expect(snapshots.map((s) => (s as { completed: string }).completed)).toEqual(['project', 'service', 'volume', 'proxy', 'variables', 'deploy', 'start']);
    expect(snapshots.at(-1)).toEqual({
      workspaceId: 'ws-1',
      name: 'Casa do Zé',
      region: 'us-east4-eqdc4a',
      nickname: 'Zé',
      completed: 'start',
      projectId: 'proj-1',
      environmentId: 'env-1',
      serviceId: 'svc-1',
      volumeId: 'vol-1',
      domain: 'roundhouse.proxy.rlwy.net',
      proxyPort: 15140,
      deploymentId: 'dep-1',
      createdAt: 1_000_000,
    });
  });

  it('follows a deployment that is already on its way instead of starting another', async () => {
    railway.on('ServiceInstance', data({ serviceInstance: { id: 'si-1', latestDeployment: { id: 'dep-auto', status: 'BUILDING', createdAt: 'x' } } }));
    railway.on('Deployment', data({ deployment: { id: 'dep-auto', status: 'SUCCESS' } }));
    const p = await connected();
    await p.create(REQUEST);
    expect(railway.ops()).not.toContain('ServiceInstanceDeployV2');
    expect(railway.variables('Deployment')).toEqual([{ id: 'dep-auto' }]);
    expect(railway.variables('DeploymentLogs')[0]).toEqual({ deploymentId: 'dep-auto', limit: 1000 });
  });

  it('goes on when the proxy exists but is not ACTIVE yet (research §12 #6), and the probe waits for it', async () => {
    railway.on('TcpProxies', data({ tcpProxies: [{ ...PROXY, syncStatus: 'CREATING' }] }));
    probe.mockRejectedValueOnce(new AppError('UNREACHABLE')).mockRejectedValueOnce(new AppError('UNREACHABLE'));
    const p = await connected();
    expect(await p.create(REQUEST)).toBe(WELCOME);
    expect(railway.ops()).not.toContain('EnvironmentPatchCommit');
    expect(probe).toHaveBeenCalledTimes(3);
    expect(log.lines.join('\n')).toContain('still CREATING');
  });

  it('refuses to join when the address answers with another key than the logs show', async () => {
    probe.mockResolvedValue({ serverKeyId: OTHER_KEY_ID, fingerprint: formatFingerprint(OTHER_KEY_ID) });
    const p = await connected();
    expect(await codeOf(p.create(REQUEST))).toBe('RAILWAY_FINGERPRINT_MISMATCH');
    expect(joinServer).not.toHaveBeenCalled();
    expect(progress.at(-1)).toEqual({ step: 'join', state: 'failed' });
    expect(p.pending()).toEqual({ name: 'Casa do Zé', region: 'us-east4-eqdc4a', step: 'join', error: 'RAILWAY_FINGERPRINT_MISMATCH' });
    expect(railwayFile().managed).toEqual([]);
  });

  it('fails with RAILWAY_DEPLOY_FAILED, logs the last lines (setup codes redacted) and resumes from deploy', async () => {
    railway
      .on('Deployment', data({ deployment: { id: 'dep-1', status: 'BUILDING' } }), data({ deployment: { id: 'dep-1', status: 'FAILED' } }))
      .on('BuildLogs', data({ buildLogs: [{ timestamp: 't', message: 'pulling image', severity: 'info' }, { timestamp: 't', message: 'manifest unknown', severity: 'error' }] }))
      .on('DeploymentLogs', data({ deploymentLogs: START_LINES }));
    const first = await connected();
    expect(await codeOf(first.create(REQUEST))).toBe('RAILWAY_DEPLOY_FAILED');
    expect(progress.at(-1)).toEqual({ step: 'deploy', state: 'failed' });
    expect(first.pending()).toEqual({ name: 'Casa do Zé', region: 'us-east4-eqdc4a', step: 'deploy', error: 'RAILWAY_DEPLOY_FAILED' });
    expect(railwayFile().pending).toMatchObject({ completed: 'variables', deploymentId: 'dep-1' });
    const logged = log.lines.join('\n');
    expect(logged).toContain('[railway build] manifest unknown');
    expect(logged).toContain('[railway deploy] Setup code (use it once to become the owner): [redacted]');
    expect(logged).not.toContain(SETUP);
    expect(joinServer).not.toHaveBeenCalled();

    // The app restarts: the record survives, the session error does not.
    const again = provisioner();
    expect(again.pending()).toEqual({ name: 'Casa do Zé', region: 'us-east4-eqdc4a', step: 'deploy', error: null });
    railway.calls.length = 0;
    progress.length = 0;
    railway
      .on('ServiceInstance', data({ serviceInstance: { id: 'si-1', latestDeployment: { id: 'dep-1', status: 'FAILED', createdAt: 'x' } } }))
      .on('ServiceInstanceDeployV2', data({ serviceInstanceDeployV2: 'dep-2' }))
      .on('Deployment', data({ deployment: { id: 'dep-2', status: 'SUCCESS' } }));
    expect(await again.resume()).toBe(WELCOME);
    expect(railway.ops()).toEqual(['ServiceInstanceUpdate', 'ServiceInstance', 'ServiceInstanceDeployV2', 'Deployment', 'DeploymentLogs']);
    expect(railway.variables('DeploymentLogs')).toEqual([{ deploymentId: 'dep-2', limit: 1000 }]);
    expect(progress[0]).toEqual({ step: 'deploy', state: 'running' });
    expect(progress.at(-1)).toEqual({ step: 'join', state: 'done' });
    expect(joinServer).toHaveBeenCalledWith(expect.objectContaining({ setupCode: SETUP, addresses: [ADDRESS] }));
    expect(again.pending()).toBeNull();
    expect(railwayFile().managed).toHaveLength(1);
  });

  it('resume() at the join step reads the setup code from the logs again', async () => {
    probe.mockRejectedValue(new AppError('UNREACHABLE'));
    const p = await connected();
    expect(await codeOf(p.create(REQUEST))).toBe('UNREACHABLE');
    expect(p.pending()).toMatchObject({ step: 'join', error: 'UNREACHABLE' });
    expect(everythingWritten()).not.toContain(SETUP);

    probe.mockResolvedValue({ serverKeyId: KEY_ID, fingerprint: formatFingerprint(KEY_ID) });
    railway.calls.length = 0;
    progress.length = 0;
    expect(await provisioner().resume()).toBe(WELCOME);
    expect(railway.ops()).toEqual(['DeploymentLogs']);
    expect(progress).toEqual([
      { step: 'join', state: 'running' },
      { step: 'join', state: 'done' },
    ]);
    expect(joinServer).toHaveBeenCalledWith(expect.objectContaining({ setupCode: SETUP }));
  });

  it('does not create a second service or volume when resuming after a lost answer', async () => {
    railway.on('ServiceInstanceUpdate', new TypeError('fetch failed'));
    const p = await connected();
    expect(await codeOf(p.create(REQUEST))).toBe('RAILWAY_API_ERROR');
    expect(railwayFile().pending).toMatchObject({ completed: 'project', serviceId: 'svc-1' });

    railway.on('ServiceInstanceUpdate', data({ serviceInstanceUpdate: true }));
    railway.on('EnvironmentVolumes', data({ environment: { volumeInstances: { edges: [{ node: { id: 'vi-1', volumeId: 'vol-0', serviceId: 'svc-1', mountPath: '/data' } }] } } }));
    railway.calls.length = 0;
    expect(await p.resume()).toBe(WELCOME);
    expect(railway.ops()).not.toContain('ServiceCreate');
    expect(railway.ops()).not.toContain('VolumeCreate');
    expect(railwayFile().managed[0]).toMatchObject({ serviceId: 'svc-1', volumeId: 'vol-0' });
  });

  it('times out when the proxy never appears, the deploy never ends or the server never prints', async () => {
    railway.on('TcpProxies', data({ tcpProxies: [] }));
    const p = await connected();
    expect(await codeOf(p.create(REQUEST))).toBe('RAILWAY_TIMEOUT');
    expect(p.pending()).toMatchObject({ step: 'proxy' });
    expect(railway.ops().filter((op) => op === 'TcpProxies').length).toBeLessThanOrEqual(22);

    railway.on('TcpProxies', data({ tcpProxies: [PROXY] })).on('Deployment', data({ deployment: { id: 'dep-1', status: 'DEPLOYING' } }));
    expect(await codeOf(p.resume())).toBe('RAILWAY_TIMEOUT');
    expect(p.pending()).toMatchObject({ step: 'deploy' });
    // Polls every 5 s for 10 minutes at most (Free: 100 requests/hour).
    expect(railway.ops().filter((op) => op === 'Deployment').length).toBeLessThanOrEqual(121);

    railway.on('ServiceInstance', data({ serviceInstance: { id: 'si-1', latestDeployment: null } })).on('Deployment', data({ deployment: { id: 'dep-1', status: 'SUCCESS' } }));
    railway.on('DeploymentLogs', data({ deploymentLogs: [START_LINES[1]] }));
    expect(await codeOf(p.resume())).toBe('RAILWAY_TIMEOUT');
    expect(p.pending()).toMatchObject({ step: 'start' });

    // A crash after SUCCESS is told apart from silence.
    railway.on('Deployment', data({ deployment: { id: 'dep-1', status: 'CRASHED' } })).on('BuildLogs', data({ buildLogs: [] }));
    expect(await codeOf(p.resume())).toBe('RAILWAY_DEPLOY_FAILED');
    expect(joinServer).not.toHaveBeenCalled();
  });

  it('follows the newer deployment when its own one is superseded', async () => {
    railway
      .on('Deployment', (v) => data({ deployment: { id: v.id, status: v.id === 'dep-1' ? 'REMOVED' : 'SUCCESS' } }))
      .on(
        'ServiceInstance',
        data({ serviceInstance: { id: 'si-1', latestDeployment: null } }),
        data({ serviceInstance: { id: 'si-1', latestDeployment: { id: 'dep-2', status: 'DEPLOYING', createdAt: 'x' } } }),
      );
    const p = await connected();
    expect(await p.create(REQUEST)).toBe(WELCOME);
    expect(railway.variables('Deployment')).toEqual([{ id: 'dep-1' }, { id: 'dep-2' }]);
    expect(railway.variables('DeploymentLogs')[0]).toEqual({ deploymentId: 'dep-2', limit: 1000 });
  });

  it('needs a token, a name, and no unfinished provisioning', async () => {
    expect(await codeOf(provisioner().create(REQUEST))).toBe('RAILWAY_NOT_CONNECTED');
    const p = await connected();
    expect(await codeOf(p.create({ ...REQUEST, name: '​‮' }))).toBe('BAD_REQUEST');
    expect(railway.calls).toEqual([]);
    railway.on('VolumeCreate', gqlError('Volume limit reached'));
    expect(await codeOf(p.create(REQUEST))).toBe('RAILWAY_API_ERROR');
    railway.calls.length = 0;
    expect(await codeOf(p.create(REQUEST))).toBe('RAILWAY_BUSY');
    expect(railway.calls).toEqual([]);
  });

  it('leaves nothing pending when the project itself could not be created', async () => {
    railway.on('ProjectCreate', gqlError('Workspace not found'));
    const p = await connected();
    expect(await codeOf(p.create(REQUEST))).toBe('RAILWAY_API_ERROR');
    expect(progress).toEqual([
      { step: 'project', state: 'running' },
      { step: 'project', state: 'failed' },
    ]);
    expect(p.pending()).toBeNull();
    expect(existsSync(join(dir.path, RAILWAY_FILE))).toBe(false);
    expect(await codeOf(p.resume())).toBe('NOT_FOUND');
  });

  it('runs one provisioning at a time', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    railway.on('ProjectCreate', async () => {
      await held;
      return data({ projectCreate: { id: 'proj-1', primaryEnvironmentId: 'env-1', environments: { edges: [{ node: { id: 'env-1', name: 'production' } }] } } });
    });
    const p = await connected();
    const running = p.create(REQUEST);
    expect(await codeOf(p.create(REQUEST))).toBe('RAILWAY_BUSY');
    expect(await codeOf(p.resume())).toBe('RAILWAY_BUSY');
    expect(await codeOf(p.discard())).toBe('RAILWAY_BUSY');
    expect(await codeOf(p.connect(TOKEN))).toBe('RAILWAY_BUSY');
    expect(() => p.disconnect()).toThrow(expect.objectContaining({ code: 'RAILWAY_BUSY' }));
    release();
    expect(await running).toBe(WELCOME);
    expect(railway.ops().filter((op) => op === 'ProjectCreate')).toHaveLength(1);
  });
});

describe('railway.discard', () => {
  async function failedAtDeploy(): Promise<RailwayProvisioner> {
    railway.on('Deployment', data({ deployment: { id: 'dep-1', status: 'CRASHED' } })).on('BuildLogs', data({ buildLogs: [] })).on('DeploymentLogs', data({ deploymentLogs: [] }));
    const p = await connected();
    expect(await codeOf(p.create(REQUEST))).toBe('RAILWAY_DEPLOY_FAILED');
    railway.calls.length = 0;
    return p;
  }

  it('deletes the pending project and forgets it', async () => {
    const p = await failedAtDeploy();
    railway.on('ProjectDelete', data({ projectDelete: true }));
    await p.discard();
    expect(railway.calls.map((c) => [c.op, c.variables])).toEqual([['ProjectDelete', { id: 'proj-1' }]]);
    expect(p.pending()).toBeNull();
    expect(railwayFile().pending).toBeNull();
    await p.discard(); // nothing left: a no-op
    expect(railway.calls).toHaveLength(1);
  });

  it('tolerates a project that is gone already', async () => {
    const p = await failedAtDeploy();
    railway.on('ProjectDelete', gqlError('Project not found'));
    await p.discard();
    expect(p.pending()).toBeNull();
  });

  it('tells a project it cannot see from a revoked token', async () => {
    const p = await failedAtDeploy();
    railway.on('ProjectDelete', gqlError('Not Authorized')).on('Project', gqlError('Not Authorized'));
    await p.discard();
    expect(railway.ops()).toEqual(['ProjectDelete', 'Project', 'ApiTokenContext']);
    expect(p.pending()).toBeNull();

    const q = await failedAtDeploy();
    railway.on('ProjectDelete', gqlError('Not Authorized')).on('Project', gqlError('Not Authorized')).on('ApiTokenContext', gqlError('Not Authorized'));
    expect(await codeOf(q.discard())).toBe('RAILWAY_TOKEN_INVALID');
    expect(q.pending()).not.toBeNull();
  });

  it('keeps the record when Railway cannot be reached, or the project still exists', async () => {
    const p = await failedAtDeploy();
    railway.on('ProjectDelete', new TypeError('fetch failed'));
    expect(await codeOf(p.discard())).toBe('RAILWAY_API_ERROR');
    expect(p.pending()).not.toBeNull();
    railway.on('ProjectDelete', gqlError('Not Authorized')).on('Project', data({ project: { id: 'proj-1', deletedAt: null } }));
    expect(await codeOf(p.discard())).toBe('RAILWAY_TOKEN_INVALID');
    expect(p.pending()).not.toBeNull();
    p.disconnect();
    expect(await codeOf(p.discard())).toBe('RAILWAY_NOT_CONNECTED');
    expect(p.pending()).not.toBeNull();
  });
});

describe('secrets', () => {
  it('never puts the token in an error, the log, the disk or a progress event', async () => {
    const errors: unknown[] = [];
    const keep = (e: unknown) => void errors.push(e);
    // A fetch failure that quotes the header, and GraphQL errors that echo the token.
    railway.on('ApiTokenContext', new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`));
    await provisioner().connect(TOKEN).catch(keep);
    railway.on('ApiTokenContext', data({ apiToken: { workspaces: [{ id: 'ws-1', name: 'Pessoal' }] } }));
    const p = await connected();
    railway.on('ProjectCreate', gqlError(`Not Authorized for token ${TOKEN}`));
    await p.create(REQUEST).catch(keep);
    railway.on('ProjectCreate', data({ projectCreate: { id: 'proj-1', primaryEnvironmentId: 'env-1', environments: { edges: [] } } }));
    railway.on('ServiceCreate', { status: 500 });
    await p.create(REQUEST).catch(keep);
    railway.on('ProjectDelete', { errors: [{ message: `bad token ${TOKEN}` }] }).on('Project', data({ project: { id: 'proj-1', deletedAt: null } }));
    await p.discard().catch(keep);
    expect(errors.map((e) => (e as AppError).code)).toEqual(['RAILWAY_API_ERROR', 'RAILWAY_TOKEN_INVALID', 'RAILWAY_API_ERROR', 'RAILWAY_API_ERROR']);
    const texts = errors.flatMap((e) => [(e as Error).message, String((e as Error).stack), JSON.stringify(e)]);
    for (const text of [...texts, ...log.lines, JSON.stringify(progress), JSON.stringify(p.pending()), everythingWritten()]) {
      expect(text).not.toContain(TOKEN);
    }
  });
});
