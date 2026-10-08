// "Criar um servidor" → "Na nuvem (Railway)" (v0.2): creates a GhostLink server in the user's
// own Railway account and joins it as the owner, in the order of the API research's §9.
// Every completed step is written to railway.json, so a failure or a closed app can resume
// later, or discard (delete) the project. Only this process ever talks to Railway.
import { formatFingerprint, formatHostPort, sanitizeLabel } from '@ghostlink/shared';
import { AppError, toAppErrorCode, type AppErrorCode } from '../../shared/appErrors.js';
import type { JoinConnectRequest, ProbeResult, RendererWelcome } from '../../shared/ipcTypes.js';
import {
  RAILWAY_STEPS,
  type RailwayAccount,
  type RailwayCreateRequest,
  type RailwayPending,
  type RailwayProgress,
  type RailwayStep,
  type RailwayWorkspace,
  type ServerEdition,
} from '../../shared/railwayTypes.js';
import type { SafeStorageLike } from '../identity.js';
import { mainLog, type Log } from '../log.js';
import { fetchWorkspaces } from './account.js';
import { RailwayClient, RailwayError, type FetchLike } from './api.js';
import { normalizeFingerprint, parseServerStart, redactLogLine } from './logs.js';
import { DATA, OPS } from './operations.js';
import { deleteRailwayProject } from './projectDelete.js';
import { RailwayStore, type ManagedServer, type PendingRecord } from './store.js';
import { RailwayTokenStore, normalizeToken } from './token.js';

export interface RailwayTiming {
  /** Deployment status and log polls; the Free plan allows 100 API requests per hour. */
  pollMs: number;
  proxyPollMs: number;
  proxyTimeoutMs: number;
  deployTimeoutMs: number;
  /** From SUCCESS until the server printed its fingerprint and setup code. */
  startTimeoutMs: number;
  /** How long the new address may stay unreachable while the proxy and the server warm up. */
  probeTimeoutMs: number;
  probeRetryMs: number;
}

export const RAILWAY_TIMING: RailwayTiming = {
  pollMs: 5_000,
  proxyPollMs: 3_000,
  proxyTimeoutMs: 60_000,
  deployTimeoutMs: 10 * 60_000,
  startTimeoutMs: 3 * 60_000,
  probeTimeoutMs: 60_000,
  probeRetryMs: 3_000,
};

/** GhostLink's port in the container and the TCP proxy's target; it never changes (research §13.5). */
export const RAILWAY_APP_PORT = 7700;
export const RAILWAY_DATA_DIR = '/data';
export const RAILWAY_PROJECT_DESCRIPTION = 'Managed by GhostLink';
const SERVICE_NAME = 'ghostlink';
const NAME_MAX = 64;
/** Enough for the start lines even behind LiveKit's own output (the API allows 5000). */
const START_LOG_LIMIT = 1_000;
const FAILURE_LOG_LIMIT = 100;
const FAILURE_LOG_LINES = 30;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

// research §8: DeploymentStatus. Also read by serverUpdates.ts, which deploys new versions.
export const IN_PROGRESS: ReadonlySet<string> = new Set(['QUEUED', 'WAITING', 'INITIALIZING', 'BUILDING', 'DEPLOYING']);
export const FAILED: ReadonlySet<string> = new Set(['FAILED', 'CRASHED']);
/** Ended without success or failure, e.g. superseded by a newer deployment. */
export const ENDED: ReadonlySet<string> = new Set(['REMOVED', 'REMOVING', 'SKIPPED', 'SLEEPING']);

/** The Railway project's name: "ghostlink-" and a slug of the server name ("Casa do Zé" → ghostlink-casa-do-ze). */
export function projectName(serverName: string): string {
  const slug = serverName
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `ghostlink-${slug || 'server'}`;
}

/**
 * Exactly what the image's entrypoint reads (apps/server/docker/entrypoint.sh). The public
 * address comes from Railway's own RAILWAY_TCP_PROXY_* variables, which the server detects.
 */
export function serverVariables(name: string): Record<string, string> {
  return {
    GHOSTLINK_NAME: name,
    GHOSTLINK_VOICE: '1',
    GHOSTLINK_PORT: String(RAILWAY_APP_PORT),
    // research §7.3: a PORT variable overrides the TCP proxy's target, so it must be the same port.
    PORT: String(RAILWAY_APP_PORT),
    GHOSTLINK_DATA: RAILWAY_DATA_DIR,
  };
}

function nextStep(completed: RailwayStep | null): RailwayStep {
  return RAILWAY_STEPS[completed === null ? 0 : RAILWAY_STEPS.indexOf(completed) + 1] ?? 'join';
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`railway: ${what} is missing from the provisioning record`);
  return value;
}

export interface RailwayProvisionerDeps {
  userDataDir: string;
  safeStorage: SafeStorageLike;
  /** railway.json, shared with the server updates (one copy in memory); loaded from userDataDir when absent. */
  store?: RailwayStore;
  /** Electron's net.fetch in production. */
  fetch: FetchLike;
  /** The image a new server boots on; a function is resolved at create time with the chosen edition (so it can read current license state). */
  image: string | ((edition: ServerEdition) => string);
  /** Whether this install can create a private-image server; surfaced in the account so the wizard can offer the choice. */
  privateServers?: () => boolean;
  /** Fresh check before a private-image server: does the key still have a free slot? Fail-open (the server enforces the real limit). */
  serversAvailable?: () => Promise<boolean>;
  /** ClientController.probe: the TOFU probe of spec §3.3. */
  probe(address: string): Promise<ProbeResult>;
  /** ClientController.join. */
  join(req: JoinConnectRequest): Promise<RendererWelcome>;
  /** Sends IPC_EVENTS.railway to the main window. */
  emit(progress: RailwayProgress): void;
  log?: Log;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timing?: Partial<RailwayTiming>;
  requestTimeoutMs?: number;
}

/** A provisioning in memory: the pending record before (and while) it can be written. */
interface Run extends Omit<PendingRecord, 'completed' | 'projectId' | 'environmentId'> {
  completed: RailwayStep | null;
  projectId?: string;
  environmentId?: string;
}

interface Ctx {
  api: RailwayClient;
  run: Run;
  resumed: boolean;
  /** Read in the start step and held in memory only: the setup code is a secret. */
  start: { fingerprint: string; setupCode: string } | null;
}

function ids(run: Run): { projectId: string; environmentId: string; serviceId: string } {
  return { projectId: need(run.projectId, 'projectId'), environmentId: need(run.environmentId, 'environmentId'), serviceId: need(run.serviceId, 'serviceId') };
}

export class RailwayProvisioner {
  readonly #deps: RailwayProvisionerDeps;
  readonly #tokens: RailwayTokenStore;
  readonly #store: RailwayStore;
  readonly #timing: RailwayTiming;
  readonly #log: Log;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** The token's workspaces, fetched once per session. */
  #workspaces: Promise<RailwayWorkspace[]> | null = null;
  #busy = false;
  /** Why the last run stopped (this session only). */
  #error: AppErrorCode | null = null;

  constructor(deps: RailwayProvisionerDeps) {
    this.#deps = deps;
    this.#tokens = new RailwayTokenStore(deps.userDataDir, deps.safeStorage);
    this.#store = deps.store ?? RailwayStore.load(deps.userDataDir);
    this.#timing = { ...RAILWAY_TIMING, ...deps.timing };
    this.#log = deps.log ?? mainLog;
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async status(): Promise<RailwayAccount> {
    const token = this.#tokens.read();
    if (token === null) {
      this.#workspaces = null;
      return { connected: false, workspaces: [], privateServers: this.#deps.privateServers?.() ?? false };
    }
    return { connected: true, workspaces: (await this.#cachedWorkspaces(token)).map((w) => ({ ...w })), privateServers: this.#deps.privateServers?.() ?? false };
  }

  /** Validates the token with Railway, then stores it encrypted; an invalid token stores nothing. */
  async connect(raw: string): Promise<RailwayAccount> {
    this.#assertIdle();
    const token = normalizeToken(raw);
    if (token === null) throw new AppError('RAILWAY_TOKEN_INVALID', 'not a token');
    if (!this.#tokens.canEncrypt()) throw new AppError('ENCRYPTION_UNAVAILABLE');
    // Exclusive too: a provisioning must never start while the token changes.
    return this.#exclusive(async () => {
      const workspaces = await fetchWorkspaces(this.#client(token), this.#log);
      this.#tokens.save(token);
      this.#workspaces = Promise.resolve(workspaces);
      this.#log.info(`[railway] connected (${workspaces.length} workspace(s))`);
      return { connected: true, workspaces: workspaces.map((w) => ({ ...w })), privateServers: this.#deps.privateServers?.() ?? false };
    });
  }

  /** Validates the token with Railway and returns its account, storing nothing (the wizard's "Testar"). */
  async test(raw: string): Promise<RailwayAccount> {
    this.#assertIdle();
    const token = normalizeToken(raw);
    if (token === null) throw new AppError('RAILWAY_TOKEN_INVALID', 'not a token');
    return this.#exclusive(async () => {
      const workspaces = await fetchWorkspaces(this.#client(token), this.#log);
      return { connected: true, workspaces: workspaces.map((w) => ({ ...w })), privateServers: this.#deps.privateServers?.() ?? false };
    });
  }

  /** Forgets the token; servers already created keep running. */
  disconnect(): RailwayAccount {
    this.#assertIdle();
    this.#tokens.clear();
    this.#workspaces = null;
    this.#log.info('[railway] disconnected');
    return { connected: false, workspaces: [], privateServers: this.#deps.privateServers?.() ?? false };
  }

  async create(req: RailwayCreateRequest): Promise<RendererWelcome> {
    this.#assertIdle();
    // The renderer offers resume or discard for an unfinished one first.
    if (this.#store.pending) throw new AppError('RAILWAY_BUSY', 'an unfinished provisioning exists');
    const name = sanitizeLabel(req.name, NAME_MAX);
    if (name === '') throw new AppError('BAD_REQUEST', 'the server needs a name');
    const token = this.#requireToken();
    // A private-image server counts against the key's limit: check before provisioning so the user gets a clear
    // error instead of a server that cannot activate. Fail-open; the server enforces the real limit on activation.
    if (req.edition === 'private' && this.#deps.serversAvailable && !(await this.#deps.serversAvailable())) {
      throw new AppError('SERVER_LIMIT', 'the key has no server slot left');
    }
    const run: Run = { workspaceId: req.workspaceId, name, region: req.region, nickname: req.nickname, edition: req.edition, createdAt: this.#now(), completed: null };
    return this.#exclusive(() => this.#run(run, token, false));
  }

  pending(): RailwayPending | null {
    const p = this.#store.pending;
    return p && { name: p.name, region: p.region, step: nextStep(p.completed), error: this.#error };
  }

  /** Goes on from the first unfinished step; the setup code is read from the logs again. */
  async resume(): Promise<RendererWelcome> {
    this.#assertIdle();
    const pending = this.#store.pending;
    if (!pending) throw new AppError('NOT_FOUND', 'nothing to resume');
    const token = this.#requireToken();
    return this.#exclusive(() => this.#run({ ...pending }, token, true));
  }

  /** Deletes the unfinished provisioning's project (research §3.3), then forgets it. */
  async discard(): Promise<void> {
    this.#assertIdle();
    const pending = this.#store.pending;
    if (!pending) return;
    const token = this.#requireToken();
    await this.#exclusive(async () => {
      await deleteRailwayProject(this.#client(token), pending.projectId, this.#log);
      this.#store.clearPending();
      this.#error = null;
      this.#log.info(`[railway] discarded project ${pending.projectId}`);
    });
  }

  /** The servers this app created (serverUpdates.ts keeps them on the app's version). */
  managed(): ManagedServer[] {
    return this.#store.managed;
  }

  async #run(run: Run, token: string, resumed: boolean): Promise<RendererWelcome> {
    const ctx: Ctx = { api: this.#client(token), run, resumed, start: null };
    this.#error = null;
    let step = nextStep(run.completed);
    try {
      for (const next of RAILWAY_STEPS.slice(RAILWAY_STEPS.indexOf(step))) {
        step = next;
        this.#progress(step, 'running');
        if (step === 'join') {
          const welcome = await this.#join(ctx);
          this.#progress(step, 'done');
          return welcome;
        }
        await this.#step(step, ctx);
        run.completed = step;
        this.#save(run);
        this.#progress(step, 'done');
      }
      throw new Error('railway: the join step always returns');
    } catch (e) {
      this.#error = toAppErrorCode(e);
      if (this.#error === 'INTERNAL') this.#log.error(`[railway] ${step} failed:`, e);
      else this.#log.warn(`[railway] ${step} failed (${this.#error}): ${e instanceof Error ? e.message : ''}`);
      this.#progress(step, 'failed');
      throw e;
    }
  }

  #step(step: Exclude<RailwayStep, 'join'>, ctx: Ctx): Promise<void> {
    switch (step) {
      case 'project':
        return this.#project(ctx);
      case 'service':
        return this.#service(ctx);
      case 'volume':
        return this.#volume(ctx);
      case 'proxy':
        return this.#proxy(ctx);
      case 'variables':
        return this.#variables(ctx);
      case 'deploy':
        return this.#deploy(ctx);
      case 'start':
        return this.#start(ctx);
    }
  }

  async #project({ api, run }: Ctx): Promise<void> {
    const { projectCreate: project } = await api.request(
      OPS.projectCreate,
      { input: { name: projectName(run.name), description: RAILWAY_PROJECT_DESCRIPTION, workspaceId: run.workspaceId, defaultEnvironmentName: 'production' } },
      DATA.projectCreate,
    );
    // research §3.1: a new project's only environment is the one to use.
    const environmentId = project.environments.edges[0]?.node.id ?? project.primaryEnvironmentId;
    if (!environmentId) throw new RailwayError('RAILWAY_API_ERROR', `project ${project.id} has no environment`);
    run.projectId = project.id;
    run.environmentId = environmentId;
    this.#log.info(`[railway] project ${project.id} created`);
  }

  async #service({ api, run }: Ctx): Promise<void> {
    const environmentId = need(run.environmentId, 'environmentId');
    if (run.serviceId === undefined) {
      // No source yet (research §4.1): nothing may deploy before the volume, proxy and variables exist.
      const input = { projectId: need(run.projectId, 'projectId'), environmentId, name: SERVICE_NAME };
      run.serviceId = (await api.request(OPS.serviceCreate, { input }, DATA.serviceCreate)).serviceCreate.id;
      this.#save(run); // a resume must not create a second service
    }
    // The region goes in before the volume, which follows it (moving it later means downtime).
    // ON_FAILURE because the Free plan forbids ALWAYS, and caps the retries at 10.
    const input = { region: run.region, numReplicas: 1, restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10, sleepApplication: false };
    await api.request(OPS.serviceInstanceUpdate, { serviceId: run.serviceId, environmentId, input }, DATA.serviceInstanceUpdate);
  }

  async #volume({ api, run, resumed }: Ctx): Promise<void> {
    const { projectId, environmentId, serviceId } = ids(run);
    if (resumed) {
      // A lost answer may have created it already, and a service takes a single volume.
      const { environment } = await api.request(OPS.environmentVolumes, { id: environmentId }, DATA.environmentVolumes);
      const existing = environment.volumeInstances.edges.find(({ node }) => node.serviceId === serviceId && node.mountPath === RAILWAY_DATA_DIR);
      if (existing) {
        run.volumeId = existing.node.volumeId;
        return;
      }
    }
    // An explicit environmentId: null would attach it nowhere, and none to every environment.
    const input = { projectId, environmentId, serviceId, mountPath: RAILWAY_DATA_DIR };
    run.volumeId = (await api.request(OPS.volumeCreate, { input }, DATA.volumeCreate)).volumeCreate.id;
  }

  async #proxy({ api, run }: Ctx): Promise<void> {
    const { environmentId, serviceId } = ids(run);
    const live = async () => {
      const { tcpProxies } = await api.request(OPS.tcpProxies, { environmentId, serviceId }, DATA.tcpProxies);
      // research §7.2: deleted entries do not count, as in the CLI.
      return tcpProxies.find((p) => p.applicationPort === RAILWAY_APP_PORT && !p.deletedAt && p.syncStatus !== 'DELETED' && p.syncStatus !== 'DELETING') ?? null;
    };
    let proxy = await live();
    if (!proxy) {
      // research §7.1: keyed by the application port; Railway picks the public port. One per service.
      const patch = { services: { [serviceId]: { networking: { tcpProxies: { [String(RAILWAY_APP_PORT)]: {} } } } } };
      const commitMessage = `GhostLink: public TCP proxy for ${RAILWAY_APP_PORT}`;
      await api.request(OPS.environmentPatchCommit, { environmentId, patch, commitMessage, skipDeploys: true }, DATA.environmentPatchCommit);
    }
    const deadline = this.#now() + this.#timing.proxyTimeoutMs;
    while (proxy?.syncStatus !== 'ACTIVE' && this.#now() < deadline) {
      await this.#sleep(this.#timing.proxyPollMs);
      proxy = await live();
    }
    if (!proxy) throw new AppError('RAILWAY_TIMEOUT', 'the TCP proxy did not appear');
    if (!HOSTNAME.test(proxy.domain) || proxy.proxyPort < 1 || proxy.proxyPort > 65535) {
      throw new RailwayError('RAILWAY_API_ERROR', 'the TCP proxy has an unusable address');
    }
    // Not verified whether a proxy made before the first deploy turns ACTIVE before it (research
    // §12 #6). Its address is known already, and the join step probes it before trusting it.
    if (proxy.syncStatus !== 'ACTIVE') this.#log.warn(`[railway] the TCP proxy is still ${proxy.syncStatus}; going on`);
    run.domain = proxy.domain;
    run.proxyPort = proxy.proxyPort;
  }

  async #variables({ api, run }: Ctx): Promise<void> {
    const { projectId, environmentId, serviceId } = ids(run);
    const input = { projectId, environmentId, serviceId, variables: serverVariables(run.name), replace: false, skipDeploys: true };
    await api.request(OPS.variableCollectionUpsert, { input }, DATA.variableCollectionUpsert);
    // research §7.5: no public HTTP domain; Railway's HTTP edge would replace the pinned TLS.
    const { domains } = await api.request(OPS.domains, { projectId, environmentId, serviceId }, DATA.domains);
    for (const domain of domains.serviceDomains) {
      await api.request(OPS.serviceDomainDelete, { id: domain.id }, DATA.serviceDomainDelete);
    }
  }

  async #deploy(ctx: Ctx): Promise<void> {
    const { api, run } = ctx;
    const { environmentId, serviceId } = ids(run);
    // The image goes in last (research §9 step 8): whether setting a source deploys by itself is
    // not verified (§12 #4), and by now the volume, proxy and variables all exist. Resolved now with the
    // run's edition, so a dynamic image reads the current license state (and the owner's choice) at create time.
    const image = typeof this.#deps.image === 'function' ? this.#deps.image(run.edition) : this.#deps.image;
    await api.request(OPS.serviceInstanceUpdate, { serviceId, environmentId, input: { source: { image } } }, DATA.serviceInstanceUpdate);
    const latest = await this.#latestDeployment(ctx);
    if (latest && (IN_PROGRESS.has(latest.status) || (latest.status === 'SUCCESS' && latest.id === run.deploymentId))) {
      run.deploymentId = latest.id; // on its way already (or it finished while the app was closed)
    } else {
      run.deploymentId = (await api.request(OPS.serviceInstanceDeployV2, { serviceId, environmentId }, DATA.serviceInstanceDeployV2)).serviceInstanceDeployV2;
    }
    this.#save(run);
    this.#log.info(`[railway] following deployment ${run.deploymentId}`);
    await this.#followDeployment(ctx);
  }

  async #followDeployment(ctx: Ctx): Promise<void> {
    const { api, run } = ctx;
    const deadline = this.#now() + this.#timing.deployTimeoutMs;
    for (;;) {
      const id = need(run.deploymentId, 'deploymentId');
      await this.#sleep(this.#timing.pollMs);
      const { status } = (await api.request(OPS.deployment, { id }, DATA.deployment)).deployment;
      if (status === 'SUCCESS') return;
      if (FAILED.has(status)) throw await this.#deployFailed(api, id, status);
      if (ENDED.has(status)) {
        // Superseded, e.g. by a deploy Railway started by itself: follow the newer one.
        const latest = await this.#latestDeployment(ctx);
        if (!latest || latest.id === id) throw await this.#deployFailed(api, id, status);
        run.deploymentId = latest.id;
        this.#save(run);
        this.#log.info(`[railway] deployment ${id} ${status}; following ${latest.id}`);
      }
      if (this.#now() >= deadline) throw new AppError('RAILWAY_TIMEOUT', `deployment ${id} still ${status}`);
    }
  }

  async #latestDeployment({ api, run }: Ctx): Promise<{ id: string; status: string } | null> {
    const { environmentId, serviceId } = ids(run);
    return (await api.request(OPS.serviceInstance, { serviceId, environmentId }, DATA.serviceInstance)).serviceInstance.latestDeployment ?? null;
  }

  /** Logs the end of the build and deploy logs to main.log (never to the renderer, setup codes redacted). */
  async #deployFailed(api: RailwayClient, id: string, status: string): Promise<AppError> {
    this.#log.error(`[railway] deployment ${id} ended ${status}`);
    const variables = { deploymentId: id, limit: FAILURE_LOG_LIMIT };
    const sources = [
      ['build', async () => (await api.request(OPS.buildLogs, variables, DATA.buildLogs)).buildLogs],
      ['deploy', async () => (await api.request(OPS.deploymentLogs, variables, DATA.deploymentLogs)).deploymentLogs],
    ] as const;
    for (const [label, read] of sources) {
      try {
        for (const line of (await read()).slice(-FAILURE_LOG_LINES)) this.#log.error(`[railway ${label}] ${redactLogLine(line.message)}`);
      } catch (e) {
        this.#log.warn(`[railway] could not read the ${label} logs (${toAppErrorCode(e)})`);
      }
    }
    return new AppError('RAILWAY_DEPLOY_FAILED', `deployment ${id} ended ${status}`);
  }

  async #start(ctx: Ctx): Promise<void> {
    ctx.start = await this.#readStart(ctx);
  }

  /** Polls the deployment logs until the server printed its fingerprint and setup code. */
  async #readStart({ api, run }: Ctx): Promise<{ fingerprint: string; setupCode: string }> {
    const id = need(run.deploymentId, 'deploymentId');
    const deadline = this.#now() + this.#timing.startTimeoutMs;
    for (;;) {
      const { deploymentLogs } = await api.request(OPS.deploymentLogs, { deploymentId: id, limit: START_LOG_LIMIT }, DATA.deploymentLogs);
      const { fingerprint, setupCode } = parseServerStart(deploymentLogs);
      if (fingerprint !== null && setupCode !== null) return { fingerprint, setupCode };
      if (this.#now() >= deadline) {
        // research §8: SUCCESS can turn into CRASHED, which looks like silence here.
        const { status } = (await api.request(OPS.deployment, { id }, DATA.deployment)).deployment;
        if (FAILED.has(status)) throw await this.#deployFailed(api, id, status);
        throw new AppError('RAILWAY_TIMEOUT', `no ${fingerprint === null ? 'fingerprint' : 'setup code'} in the logs of ${id}`);
      }
      await this.#sleep(this.#timing.pollMs);
    }
  }

  async #join(ctx: Ctx): Promise<RendererWelcome> {
    const { run } = ctx;
    const { projectId, environmentId, serviceId } = ids(run);
    // After resume() the setup code is not in memory: it is never written anywhere, so read it again.
    const start = ctx.start ?? (await this.#readStart(ctx));
    const address = formatHostPort(need(run.domain, 'domain'), need(run.proxyPort, 'proxyPort'));
    const { serverKeyId } = await this.#probe(address);
    const answered = formatFingerprint(serverKeyId);
    // The security check: the logs came over the authenticated Railway API, so the address
    // must answer with the key the server printed there. Otherwise never join (no blind TOFU).
    if (normalizeFingerprint(answered) !== normalizeFingerprint(start.fingerprint)) {
      this.#log.error(`[railway] ${address} answers with ${answered}, but the server printed ${start.fingerprint}`);
      throw new AppError('RAILWAY_FINGERPRINT_MISMATCH');
    }
    const welcome = await this.#deps.join({ addresses: [address], serverKeyId, setupCode: start.setupCode, nickname: run.nickname, name: run.name });
    this.#store.complete({ projectId, environmentId, serviceId, volumeId: need(run.volumeId, 'volumeId'), address, serverKeyId, region: run.region, createdAt: run.createdAt });
    this.#log.info(`[railway] joined ${address} as the owner`);
    return welcome;
  }

  /** The TOFU probe, repeated while the new address does not answer yet. */
  async #probe(address: string): Promise<ProbeResult> {
    const deadline = this.#now() + this.#timing.probeTimeoutMs;
    for (;;) {
      try {
        return await this.#deps.probe(address);
      } catch (e) {
        if (toAppErrorCode(e) !== 'UNREACHABLE' || this.#now() >= deadline) throw e;
      }
      await this.#sleep(this.#timing.probeRetryMs);
    }
  }

  #cachedWorkspaces(token: string): Promise<RailwayWorkspace[]> {
    if (!this.#workspaces) {
      const loading = fetchWorkspaces(this.#client(token), this.#log);
      this.#workspaces = loading;
      loading.catch(() => {
        if (this.#workspaces === loading) this.#workspaces = null;
      });
    }
    return this.#workspaces;
  }

  /** Writes the record once the project exists; nothing before (there is nothing to resume or delete). */
  #save(run: Run): void {
    if (run.completed === null || run.projectId === undefined || run.environmentId === undefined) return;
    this.#store.savePending({ ...run, completed: run.completed, projectId: run.projectId, environmentId: run.environmentId });
  }

  #progress(step: RailwayStep, state: RailwayProgress['state']): void {
    this.#deps.emit({ step, state });
  }

  #client(token: string): RailwayClient {
    return new RailwayClient({ token, fetch: this.#deps.fetch, sleep: this.#sleep, now: this.#now, log: this.#log, timeoutMs: this.#deps.requestTimeoutMs });
  }

  #requireToken(): string {
    const token = this.#tokens.read();
    if (token === null) throw new AppError('RAILWAY_NOT_CONNECTED');
    return token;
  }

  /** One provisioning (or token change) at a time. */
  #assertIdle(): void {
    if (this.#busy) throw new AppError('RAILWAY_BUSY');
  }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.#busy = true;
    try {
      return await work();
    } finally {
      this.#busy = false;
    }
  }
}
