// Deleting a server, the owner's app side (leave/delete spec §3, §4). `server.delete` takes the
// server offline at once; the server erases its own data 48 h later. What is left belongs to the
// app: the Railway project of a server it created (railway.json `managed`) and the data dir of
// the server hosted on this computer. Both go only after the deadline the server announced
// (recorded locally from `server.deleting`, in the local clock) has passed, or once the server
// answered SERVER_DELETED — never before. A restore clears the record. Runs at start, then every
// 30 min next to the server updates (railway/serverUpdates.ts).
import { toAppErrorCode } from '../shared/appErrors.js';
import type { DeletionUpdate } from './controller.js';
import type { HostManager } from './hostManager.js';
import { mainLog, type Log } from './log.js';
import { RailwayClient, type FetchLike } from './railway/api.js';
import { deleteRailwayProject } from './railway/projectDelete.js';
import { SERVER_UPDATE_TIMING, type Timers } from './railway/serverUpdates.js';
import type { ManagedServer, RailwayStore } from './railway/store.js';

export type RailwayDeletionDecision = 'keep' | 'wait' | 'delete';

/**
 * Whether the Railway project of a managed server goes now (spec §4): only once the server said
 * SERVER_DELETED, or once the recorded deadline has passed. Without a record (never deleted, or
 * restored) it stays.
 */
export function railwayDeletionDecision(server: Pick<ManagedServer, 'deletingAt'>, now: number, confirmedDeleted: boolean): RailwayDeletionDecision {
  if (confirmedDeleted) return 'delete';
  if (server.deletingAt === undefined) return 'keep';
  return now >= server.deletingAt ? 'delete' : 'wait';
}

const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ServerDeletionsDeps {
  /** railway.json, the same instance the provisioner and the server updates use. */
  railway: Pick<RailwayStore, 'managed' | 'setDeletingAt' | 'removeManaged'>;
  /** The stored Railway token (RailwayTokenStore.read); null when there is none. */
  token(): string | null;
  /** Electron's net.fetch in production (Railway's API). */
  fetch: FetchLike;
  /** The server hosted here: its deletion record and the erase of its data dir. */
  host: Pick<HostManager, 'markDeleting' | 'eraseIfDue'>;
  /** Takes the server out of the saved list (and disconnects from it). */
  forget(serverKeyId: string): Promise<void>;
  log?: Log;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timers?: Timers;
  intervalMs?: number;
  requestTimeoutMs?: number;
}

export class ServerDeletions {
  readonly #deps: ServerDeletionsDeps;
  readonly #log: Log;
  readonly #now: () => number;
  readonly #timers: Timers;
  readonly #intervalMs: number;
  /** Servers that answered SERVER_DELETED in this session: their deadline passed on the server's clock. */
  readonly #confirmed = new Set<string>();
  #queue: Promise<void> = Promise.resolve();
  #timer: unknown = null;
  #started = false;
  #disposed = false;

  constructor(deps: ServerDeletionsDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? mainLog;
    this.#now = deps.now ?? Date.now;
    this.#timers = deps.timers ?? REAL_TIMERS;
    this.#intervalMs = deps.intervalMs ?? SERVER_UPDATE_TIMING.intervalMs;
  }

  /** What the controller learned (ClientController's onDeletion). Records even before start(). */
  observe(update: DeletionUpdate): void {
    const { serverKeyId } = update;
    switch (update.kind) {
      case 'deleting':
        this.#deps.railway.setDeletingAt(serverKeyId, update.at);
        this.#deps.host.markDeleting(serverKeyId, update.at);
        return;
      case 'restored':
        this.#confirmed.delete(serverKeyId);
        this.#deps.railway.setDeletingAt(serverKeyId, null);
        this.#deps.host.markDeleting(serverKeyId, null);
        return;
      case 'deleted':
        this.#confirmed.add(serverKeyId);
        if (this.#started) void this.sweepNow();
        return;
    }
  }

  /** The first sweep now (the next opening after a deadline erases at once), then every 30 min. */
  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    void this.sweepNow();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** One sweep after whatever is running; schedules the next one. */
  sweepNow(): Promise<void> {
    const run = this.#queue.then(() => this.#sweep()).then(
      () => undefined,
      (e: unknown) => this.#log.error('[server-delete] unexpected failure:', e),
    );
    this.#queue = run.then(() => this.#schedule());
    return run;
  }

  async #sweep(): Promise<void> {
    if (this.#disposed) return;
    const now = this.#now();
    for (const server of this.#deps.railway.managed) {
      if (railwayDeletionDecision(server, now, this.#confirmed.has(server.serverKeyId)) === 'delete') await this.#deleteRailway(server);
    }
    try {
      const erased = await this.#deps.host.eraseIfDue(now, this.#confirmed);
      if (erased !== null) {
        this.#confirmed.delete(erased);
        await this.#deps.forget(erased);
      }
    } catch (e) {
      this.#log.warn(`[server-delete] the deleted server hosted here could not be erased yet (${toAppErrorCode(e)})`);
    }
  }

  async #deleteRailway(server: ManagedServer): Promise<void> {
    const token = this.#deps.token();
    if (token === null) {
      this.#log.warn(`[server-delete] ${server.address} was deleted; its Railway project goes once Railway is connected again`);
      return;
    }
    const api = new RailwayClient({ token, fetch: this.#deps.fetch, sleep: this.#deps.sleep, now: this.#now, log: this.#log, timeoutMs: this.#deps.requestTimeoutMs });
    try {
      await deleteRailwayProject(api, server.projectId, this.#log);
    } catch (e) {
      this.#log.warn(`[server-delete] could not delete the Railway project of ${server.address} (${toAppErrorCode(e)}); trying again at the next check`);
      return;
    }
    this.#deps.railway.removeManaged(server.serverKeyId);
    this.#confirmed.delete(server.serverKeyId);
    await this.#deps.forget(server.serverKeyId);
    this.#log.info(`[server-delete] ${server.address} was erased: its Railway project ${server.projectId} is deleted`);
  }

  #schedule(): void {
    if (!this.#started || this.#disposed) return;
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      void this.sweepNow();
    }, this.#intervalMs);
  }
}
