import type { ErrorCode } from '@ghostlink/shared';
import type { ServerEvent, SessionCloseInfo, SessionCloseReason, SessionInfo, SessionsApi } from '../modules.js';
import { SessionRegistry, type SessionHandle } from './sessions.js';

export interface SessionHooks {
  opened(session: SessionInfo): void;
  closed(session: SessionInfo, info: SessionCloseInfo): void;
}

interface Grace {
  timer: NodeJS.Timeout;
  session: SessionInfo;
}

function infoOf(handle: SessionHandle): SessionInfo {
  return { userId: handle.userId, sessionId: handle.sessionId };
}

/**
 * The session registry plus the presence grace (spec §5.1): a user stays
 * "online or in grace" for `graceMs` after their last session ends, so a quick
 * reconnect is invisible to modules. Implements the SessionsApi given to modules.
 *
 * Hook contract (see SessionCloseInfo): every opened session gets exactly one
 * `closed(graceExpired: false)`; every transition to offline gets exactly one
 * `closed(graceExpired: true)` — after the grace, or at once for closeUser().
 */
export class SessionHub implements SessionsApi {
  readonly #registry = new SessionRegistry();
  readonly #grace = new Map<string, Grace>();
  readonly #opened = new WeakSet<SessionHandle>();
  readonly #ended = new WeakSet<SessionHandle>();
  readonly #graceMs: number;
  readonly #hooks: SessionHooks;
  #shuttingDown = false;
  /** The narrow view handed to modules (none of the gateway-side methods). */
  readonly api: SessionsApi = Object.freeze<SessionsApi>({
    list: () => this.list(),
    send: (sessionId, event) => this.send(sessionId, event),
    broadcast: (event, filter) => this.broadcast(event, filter),
    closeUser: (userId, code) => this.closeUser(userId, code),
    isOnlineOrInGrace: (userId) => this.isOnlineOrInGrace(userId),
  });

  constructor(opts: { graceMs: number; hooks: SessionHooks }) {
    this.#graceMs = opts.graceMs;
    this.#hooks = opts.hooks;
  }

  // ---- gateway side ----

  /** Registers a freshly authenticated session; an older one of the same user is terminated. */
  add(handle: SessionHandle): void {
    this.#registry.add(handle);
  }

  /** The welcome was sent: cancels a pending grace and tells the modules. */
  opened(handle: SessionHandle): void {
    if (this.#ended.has(handle) || !this.#registry.isCurrent(handle)) return;
    this.#cancelGrace(handle.userId);
    this.#opened.add(handle);
    this.#hooks.opened(infoOf(handle));
  }

  /** The session's socket closed. Idempotent. */
  ended(handle: SessionHandle, reason: SessionCloseReason): void {
    this.#end(handle, reason, false);
  }

  isCurrent(handle: SessionHandle): boolean {
    return this.#registry.isCurrent(handle);
  }

  /** Server shutdown: pending graces are dropped silently and no new one starts. */
  shutdown(): void {
    this.#shuttingDown = true;
    for (const { timer } of this.#grace.values()) clearTimeout(timer);
    this.#grace.clear();
  }

  get size(): number {
    return this.#registry.size;
  }

  // ---- SessionsApi (modules) ----

  list(): SessionInfo[] {
    return this.#registry.list().map(infoOf);
  }

  send(sessionId: string, event: ServerEvent): boolean {
    const handle = this.#registry.getBySession(sessionId);
    if (!handle) return false;
    handle.send(event);
    return true;
  }

  broadcast(event: ServerEvent, filter?: (session: SessionInfo) => boolean): number {
    let sent = 0;
    for (const handle of this.#registry.list()) {
      if (filter && !filter(infoOf(handle))) continue;
      handle.send(event);
      sent++;
    }
    return sent;
  }

  closeUser(userId: string, code: ErrorCode): boolean {
    const handle = this.#registry.get(userId);
    if (handle) {
      this.#end(handle, code, true);
      handle.terminate(code);
      return true;
    }
    const grace = this.#grace.get(userId);
    if (!grace) return false;
    this.#cancelGrace(userId);
    this.#hooks.closed(grace.session, { reason: code, graceExpired: true });
    return true;
  }

  isOnlineOrInGrace(userId: string): boolean {
    return this.#registry.get(userId) !== undefined || this.#grace.has(userId);
  }

  // ---- internals ----

  #end(handle: SessionHandle, reason: SessionCloseReason, evicted: boolean): void {
    if (this.#ended.has(handle)) return;
    this.#ended.add(handle);
    this.#registry.remove(handle);
    if (!this.#opened.has(handle)) return; // modules never saw it
    const session = infoOf(handle);
    this.#hooks.closed(session, { reason, graceExpired: false });
    if (this.#registry.get(handle.userId) || this.#shuttingDown) return; // still online elsewhere, or stopping
    if (evicted) {
      this.#hooks.closed(session, { reason, graceExpired: true });
      return;
    }
    this.#cancelGrace(handle.userId);
    const timer = setTimeout(() => {
      this.#grace.delete(handle.userId);
      this.#hooks.closed(session, { reason, graceExpired: true });
    }, this.#graceMs);
    timer.unref();
    this.#grace.set(handle.userId, { timer, session });
  }

  #cancelGrace(userId: string): void {
    const grace = this.#grace.get(userId);
    if (!grace) return;
    clearTimeout(grace.timer);
    this.#grace.delete(userId);
  }
}
