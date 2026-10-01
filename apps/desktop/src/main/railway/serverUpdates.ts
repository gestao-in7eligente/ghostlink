// Servers follow the app's version (spec 2026-10-01 §3): the owner's app keeps every Railway
// server it created (railway.json `managed`) on its own version. After the update check at
// startup, then every 30 min: GET /health; when the server is older, GET /owner/status; when
// nobody is in a call, or it has been behind for 24 h, the service's image becomes this app's
// version and Railway deploys it (the volume and the variables stay). Only servers in `managed`,
// only to app.getVersion(), only with the Railway token connected. The log never gets the token
// (RailwayClient scrubs it) nor a signed URL (serverStatus.ts keeps it out of errors).
import { compareReleaseVersions, isReleaseVersion } from '@ghostlink/shared';
import { AppError, toAppErrorCode } from '../../shared/appErrors.js';
import type { ManagedServerUpdate, ServerUpdateState } from '../../shared/serverUpdateTypes.js';
import type { ServerKey } from '../identity.js';
import { mainLog, type Log } from '../log.js';
import type { PinnedTarget } from '../pinnedHttp.js';
import { RailwayClient, type FetchLike } from './api.js';
import { redactLogLine } from './logs.js';
import { DATA, OPS } from './operations.js';
import { ENDED, FAILED, IN_PROGRESS, RAILWAY_TIMING } from './provisioner.js';
import { fetchHealth, fetchOwnerStatus, type OwnerStatus, type ServerHealth } from './serverStatus.js';
import type { ManagedServer, RailwayStore } from './store.js';

export interface ServerUpdateTiming {
  /** Between two checks of every managed server. */
  intervalMs: number;
  /** The next check while a server waits for its call to empty. */
  waitingRecheckMs: number;
  /** Behind for this long: update even with someone in a call. */
  forceAfterMs: number;
  /** Deployment status polls (the Free plan allows 100 API requests per hour). */
  pollMs: number;
  deployTimeoutMs: number;
  /** After SUCCESS, how long /health may take to answer the new version. */
  confirmTimeoutMs: number;
  confirmRetryMs: number;
}

export const SERVER_UPDATE_TIMING: ServerUpdateTiming = {
  intervalMs: 30 * 60_000,
  waitingRecheckMs: 10 * 60_000,
  forceAfterMs: 24 * 60 * 60_000,
  pollMs: 10_000,
  deployTimeoutMs: RAILWAY_TIMING.deployTimeoutMs,
  confirmTimeoutMs: 3 * 60_000,
  confirmRetryMs: 5_000,
};

const FAILURE_LOG_LIMIT = 100;
const FAILURE_LOG_LINES = 30;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ServerUpdatesDeps {
  /** railway.json, the same instance the provisioner writes. */
  store: Pick<RailwayStore, 'managed' | 'setOutdatedSince'>;
  /** The stored Railway token (RailwayTokenStore.read); null when there is none. */
  token(): string | null;
  /** Electron's net.fetch in production (Railway's API). */
  fetch: FetchLike;
  /** app.getVersion(): the only version servers are updated to. */
  appVersion: string;
  /** railwayImage() for appVersion. */
  image: string;
  /** IdentityStore.serverKey: my key for that server; throws while the identity is locked. */
  serverKey(serverKeyId: string): Pick<ServerKey, 'sign'>;
  /** Sends IPC_EVENTS.serverUpdates to the main window. */
  emit(update: ManagedServerUpdate): void;
  /** GET /health (serverStatus.fetchHealth). */
  health?(server: PinnedTarget): Promise<ServerHealth>;
  /** The signed GET /owner/status (serverStatus.fetchOwnerStatus). */
  ownerStatus?(server: PinnedTarget, key: Pick<ServerKey, 'sign'>): Promise<OwnerStatus>;
  log?: Log;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timers?: Timers;
  timing?: Partial<ServerUpdateTiming>;
  requestTimeoutMs?: number;
}

export class ServerUpdates {
  readonly #deps: ServerUpdatesDeps;
  readonly #timing: ServerUpdateTiming;
  readonly #log: Log;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timers: Timers;
  readonly #health: (server: PinnedTarget) => Promise<ServerHealth>;
  readonly #ownerStatus: (server: PinnedTarget, key: Pick<ServerKey, 'sign'>) => Promise<OwnerStatus>;
  /** What the page knows, per serverKeyId (this session only). */
  readonly #states = new Map<string, ManagedServerUpdate>();
  /** One check or update at a time, in order. */
  #queue: Promise<void> = Promise.resolve();
  #timer: unknown = null;
  #started = false;
  #disposed = false;

  constructor(deps: ServerUpdatesDeps) {
    this.#deps = deps;
    this.#timing = { ...SERVER_UPDATE_TIMING, ...deps.timing };
    this.#log = deps.log ?? mainLog;
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#timers = deps.timers ?? REAL_TIMERS;
    this.#health = deps.health ?? ((server) => fetchHealth(server));
    this.#ownerStatus = deps.ownerStatus ?? ((server, key) => fetchOwnerStatus(server, key, { now: this.#now }));
  }

  /** The first check now (main calls this after the update check at startup), then every 30 min. */
  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    void this.checkNow();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Checks every managed server (after whatever is running), then schedules the next check. */
  checkNow(): Promise<void> {
    return this.#enqueue(() => this.#cycle());
  }

  /** Resolves once everything queued so far has finished. */
  settled(): Promise<void> {
    return this.#queue;
  }

  /** The update of a server this app created on Railway; null for any other server. */
  state(serverKeyId: string): ManagedServerUpdate | null {
    if (!this.#record(serverKeyId)) return null;
    const known = this.#states.get(serverKeyId);
    return known ? { ...known } : { serverKeyId, version: null, target: this.#deps.appVersion, state: 'unknown' };
  }

  /**
   * "Atualizar agora" (spec §5): the update without waiting for the call to empty, after the
   * page's confirmation. Returns at once (state `updating`); the end arrives through emit.
   */
  updateNow(serverKeyId: string): ManagedServerUpdate {
    const server = this.#record(serverKeyId);
    if (!server) throw new AppError('NOT_FOUND', 'not a server this app created on Railway');
    if (this.#deps.token() === null) throw new AppError('RAILWAY_NOT_CONNECTED');
    const current = this.state(serverKeyId)!;
    if (current.state === 'updating') return current;
    this.#set(server, 'updating', current.version);
    void this.#enqueue(() => this.#check(serverKeyId, true));
    return this.state(serverKeyId)!;
  }

  #enqueue(work: () => Promise<unknown>): Promise<void> {
    const run = this.#queue.then(work).then(
      () => undefined,
      (e: unknown) => this.#log.error('[server-update] unexpected failure:', e),
    );
    this.#queue = run;
    return run;
  }

  async #cycle(): Promise<void> {
    let waiting = false;
    for (const { serverKeyId } of this.#deps.store.managed) {
      if (this.#disposed) return;
      if ((await this.#check(serverKeyId, false)) === 'waiting') waiting = true;
    }
    // spec §3: a server waiting for its call to empty is asked again in 10 min.
    this.#schedule(waiting ? this.#timing.waitingRecheckMs : this.#timing.intervalMs);
  }

  #schedule(ms: number): void {
    if (!this.#started || this.#disposed) return;
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      void this.checkNow();
    }, ms);
  }

  /** Steps 1–5 of spec §3 for one server. `force`: "Atualizar agora", no wait for the call. */
  async #check(serverKeyId: string, force: boolean): Promise<ServerUpdateState> {
    const server = this.#record(serverKeyId);
    if (!server) {
      this.#states.delete(serverKeyId);
      return 'unknown';
    }
    const previous = this.#states.get(serverKeyId);
    let version: string;
    try {
      version = (await this.#health(server)).version;
    } catch (e) {
      this.#log.warn(`[server-update] ${server.address}: no answer from /health (${toAppErrorCode(e)})`);
      // Unknown for now; only an update that cannot start becomes a failure.
      const state = force ? 'failed' : (previous?.state ?? 'unknown');
      return this.#set(server, state, previous?.version ?? null);
    }
    const { appVersion } = this.#deps;
    if (!isReleaseVersion(version)) {
      this.#log.warn(`[server-update] ${server.address}: /health answers a version that is not a release; left alone`);
      return this.#set(server, 'unknown', null);
    }
    // 1. The same version or a newer one: nothing to do.
    if (compareReleaseVersions(version, appVersion) >= 0) {
      if (server.outdatedSince !== undefined) this.#deps.store.setOutdatedSince(serverKeyId, null);
      return this.#set(server, 'current', version);
    }
    // 2. Older: remember since when.
    const now = this.#now();
    const since = server.outdatedSince ?? now;
    if (server.outdatedSince === undefined) {
      this.#deps.store.setOutdatedSince(serverKeyId, since);
      this.#log.info(`[server-update] ${server.address} runs ${version}, older than the app's ${appVersion}`);
    }
    const token = this.#deps.token();
    if (token === null) return this.#set(server, 'railwayDisconnected', version);
    // 3. Nobody in a call, or behind for 24 h already.
    const overdue = now - since >= this.#timing.forceAfterMs;
    if (!force && !overdue && !(await this.#idle(server))) return this.#set(server, 'waiting', version);
    if (!force && overdue) this.#log.info(`[server-update] ${server.address} has been behind for 24 h: updating even with a call`);
    return this.#update(server, token, version);
  }

  /** true only when the server itself said nobody is in a call; anything else means wait. */
  async #idle(server: ManagedServer): Promise<boolean> {
    try {
      return !(await this.#ownerStatus(server, this.#deps.serverKey(server.serverKeyId))).voiceActive;
    } catch (e) {
      // FORBIDDEN: not the owner any more, another identity, or a clock off by more than 60 s.
      // NOT_FOUND: a server older than v0.2.2. Either way the 24 h rule still applies.
      this.#log.warn(`[server-update] ${server.address}: /owner/status failed (${toAppErrorCode(e)}); waiting`);
      return false;
    }
  }

  /** Steps 4–5: the new image, a deploy until SUCCESS, then /health with the new version. */
  async #update(server: ManagedServer, token: string, from: string): Promise<ServerUpdateState> {
    const { appVersion, image } = this.#deps;
    this.#set(server, 'updating', from);
    this.#log.info(`[server-update] updating ${server.address} from ${from} to ${appVersion}`);
    const api = new RailwayClient({ token, fetch: this.#deps.fetch, sleep: this.#sleep, now: this.#now, log: this.#log, timeoutMs: this.#deps.requestTimeoutMs });
    let version: string;
    try {
      const ids = { serviceId: server.serviceId, environmentId: server.environmentId };
      await api.request(OPS.serviceInstanceUpdate, { ...ids, input: { source: { image } } }, DATA.serviceInstanceUpdate);
      await this.#follow(api, server, await this.#deploy(api, server));
      version = await this.#confirm(server);
    } catch (e) {
      const code = toAppErrorCode(e);
      if (code === 'INTERNAL') this.#log.error(`[server-update] ${server.address}: the update to ${appVersion} failed:`, e);
      else this.#log.warn(`[server-update] ${server.address}: the update to ${appVersion} failed (${code}); trying again at the next check`);
      return this.#set(server, code === 'RAILWAY_TOKEN_INVALID' ? 'railwayDisconnected' : 'failed', from);
    }
    this.#deps.store.setOutdatedSince(server.serverKeyId, null);
    this.#log.info(`[server-update] ${server.address} now runs ${version}`);
    return this.#set(server, 'current', version);
  }

  /** The deployment to follow: one already on its way, else a new one (the provisioner's deploy step). */
  async #deploy(api: RailwayClient, server: ManagedServer): Promise<string> {
    // Whether setting the image deploys by itself is not verified (research §12 #4).
    const latest = await this.#latestDeployment(api, server);
    if (latest && IN_PROGRESS.has(latest.status)) return latest.id;
    const ids = { serviceId: server.serviceId, environmentId: server.environmentId };
    return (await api.request(OPS.serviceInstanceDeployV2, ids, DATA.serviceInstanceDeployV2)).serviceInstanceDeployV2;
  }

  async #follow(api: RailwayClient, server: ManagedServer, first: string): Promise<void> {
    const deadline = this.#now() + this.#timing.deployTimeoutMs;
    let id = first;
    for (;;) {
      await this.#sleep(this.#timing.pollMs);
      const { status } = (await api.request(OPS.deployment, { id }, DATA.deployment)).deployment;
      if (status === 'SUCCESS') return;
      if (FAILED.has(status)) throw await this.#deployFailed(api, id, status);
      if (ENDED.has(status)) {
        // Superseded, e.g. by a deploy Railway started by itself: follow the newer one.
        const latest = await this.#latestDeployment(api, server);
        if (!latest || latest.id === id) throw await this.#deployFailed(api, id, status);
        this.#log.info(`[server-update] deployment ${id} ${status}; following ${latest.id}`);
        id = latest.id;
      }
      if (this.#now() >= deadline) throw new AppError('RAILWAY_TIMEOUT', `deployment ${id} still ${status}`);
    }
  }

  async #latestDeployment(api: RailwayClient, server: ManagedServer): Promise<{ id: string; status: string } | null> {
    const ids = { serviceId: server.serviceId, environmentId: server.environmentId };
    return (await api.request(OPS.serviceInstance, ids, DATA.serviceInstance)).serviceInstance.latestDeployment ?? null;
  }

  /** The end of the build and deploy logs go to main.log (redacted), never to the page. */
  async #deployFailed(api: RailwayClient, id: string, status: string): Promise<AppError> {
    this.#log.error(`[server-update] deployment ${id} ended ${status}`);
    const variables = { deploymentId: id, limit: FAILURE_LOG_LIMIT };
    const sources = [
      ['build', async () => (await api.request(OPS.buildLogs, variables, DATA.buildLogs)).buildLogs],
      ['deploy', async () => (await api.request(OPS.deploymentLogs, variables, DATA.deploymentLogs)).deploymentLogs],
    ] as const;
    for (const [label, read] of sources) {
      try {
        for (const line of (await read()).slice(-FAILURE_LOG_LINES)) this.#log.error(`[railway ${label}] ${redactLogLine(line.message)}`);
      } catch (e) {
        this.#log.warn(`[server-update] could not read the ${label} logs (${toAppErrorCode(e)})`);
      }
    }
    return new AppError('RAILWAY_DEPLOY_FAILED', `deployment ${id} ended ${status}`);
  }

  /** /health until it answers the app's version (the container restarts after SUCCESS). */
  async #confirm(server: ManagedServer): Promise<string> {
    const { appVersion } = this.#deps;
    const deadline = this.#now() + this.#timing.confirmTimeoutMs;
    for (;;) {
      try {
        const { version } = await this.#health(server);
        if (isReleaseVersion(version) && compareReleaseVersions(version, appVersion) >= 0) return version;
      } catch {
        // still restarting
      }
      if (this.#now() >= deadline) throw new AppError('RAILWAY_TIMEOUT', `the server does not answer ${appVersion} yet`);
      await this.#sleep(this.#timing.confirmRetryMs);
    }
  }

  #record(serverKeyId: string): ManagedServer | undefined {
    return this.#deps.store.managed.find((m) => m.serverKeyId === serverKeyId);
  }

  /** Keeps the state and tells the page when it changed. */
  #set(server: ManagedServer, state: ServerUpdateState, version: string | null): ServerUpdateState {
    const next: ManagedServerUpdate = { serverKeyId: server.serverKeyId, version, target: this.#deps.appVersion, state };
    const previous = this.#states.get(server.serverKeyId);
    this.#states.set(server.serverKeyId, next);
    if (previous?.state !== state || previous.version !== version) this.#deps.emit({ ...next });
    return state;
  }
}
