import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { PROTOCOL, ProtocolError, type Envelope, type WelcomePayload } from '@ghostlink/shared';
import { ChallengeStore } from '../auth/challenges.js';
import { HandshakeFailed, runHandshake, type AuthedSession } from '../auth/handshake.js';
import type { Db } from '../db/database.js';
import { getMeta } from '../db/serverMeta.js';
import type { ServerLimits } from '../limits.js';
import type { Logger } from '../logger.js';
import type { ModuleHost } from '../moduleHost.js';
import type { RequestContext, SessionInfo } from '../modules.js';
import { PER_ADDRESS, SlidingWindowLimiter, type ClientAddressing } from '../ratelimit/limiter.js';
import { Connection, ConnectionClosedError } from './connection.js';
import { createDispatcher, errorResponse } from './dispatch.js';
import { SessionHub } from './sessionHub.js';
import type { SessionHandle } from './sessions.js';

export interface GatewayDeps {
  db: Db;
  dataDir: string;
  serverKeyId: string;
  version: string;
  limits: ServerLimits;
  now: () => number;
  logger: Logger;
  modules: ModuleHost;
  /** Per address (default), or one shared key behind a TCP proxy (spec §13). */
  addressing?: ClientAddressing;
}

const SWEEP_INTERVAL_MS = 60_000;
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * Owns every WebSocket: pre-auth admission limits (spec §13), the handshake,
 * the one-session-per-identity registry (with the presence grace) and the
 * post-auth request loop, which dispatches to the module handlers.
 */
export class Gateway {
  /** Also the SessionsApi handed to modules. */
  readonly sessions: SessionHub;
  readonly #deps: GatewayDeps;
  readonly #addressing: ClientAddressing;
  readonly #wss: WebSocketServer;
  readonly #connections = new Set<Connection>();
  readonly #unauthenticatedPerIp = new Map<string, number>();
  #unauthenticated = 0;
  #closing = false;
  readonly #challenges: ChallengeStore;
  readonly #authFailures: SlidingWindowLimiter;
  readonly #newIdentities: SlidingWindowLimiter;
  readonly #sweepTimer: NodeJS.Timeout;
  readonly #dispatch: ReturnType<typeof createDispatcher>;

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
    this.#addressing = deps.addressing ?? PER_ADDRESS;
    const { limits, now, modules } = deps;
    this.sessions = new SessionHub({
      graceMs: limits.presenceGraceMs,
      hooks: {
        opened: (session) => modules.sessionOpened(session),
        closed: (session, info) => modules.sessionClosed(session, info),
      },
    });
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: limits.maxPayloadBytes,
      perMessageDeflate: false,
      clientTracking: false,
    });
    this.#challenges = new ChallengeStore({ ttlMs: limits.challengeTtlMs, maxPendingPerIp: limits.pendingChallengesPerIp, now });
    this.#authFailures = new SlidingWindowLimiter(limits.authFailuresPerIpPerMinute, 60_000, now);
    this.#newIdentities = new SlidingWindowLimiter(limits.newIdentitiesPerIpPerHour, 3_600_000, now);
    this.#dispatch = createDispatcher(modules.handlers, deps.logger);
    this.#sweepTimer = setInterval(() => {
      this.#authFailures.sweep();
      this.#newIdentities.sweep();
    }, SWEEP_INTERVAL_MS);
    this.#sweepTimer.unref();
  }

  get stats(): { connections: number; unauthenticated: number; sessions: number } {
    return { connections: this.#connections.size, unauthenticated: this.#unauthenticated, sessions: this.sessions.size };
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.#closing) {
      socket.destroy();
      return;
    }
    const ip = req.socket.remoteAddress ?? 'unknown';
    const requestHost = req.headers.host;
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      const { limits } = this.#deps;
      const conn = new Connection(ws, { ip, ipKey: this.#addressing.keyOf(ip), pingIntervalMs: limits.pingIntervalMs, pongTimeoutMs: limits.pongTimeoutMs });
      this.#connections.add(conn);
      conn.onClose(() => this.#connections.delete(conn));
      const perIp = this.#unauthenticatedPerIp.get(conn.ipKey) ?? 0;
      if (this.#unauthenticated >= limits.maxUnauthenticatedConnections || perIp >= limits.maxConnectionsPerIp) {
        conn.close('RATE_LIMITED');
        return;
      }
      void this.#serve(conn, requestHost);
    });
  }

  /** Graceful shutdown: every socket gets `error { SERVER_SHUTDOWN }`, stragglers are terminated. */
  async close(): Promise<void> {
    this.#closing = true;
    this.sessions.shutdown();
    clearInterval(this.#sweepTimer);
    const pending = [...this.#connections].map((conn) => new Promise<void>((resolve) => {
      conn.onClose(resolve);
      conn.close('SERVER_SHUTDOWN');
    }));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    await Promise.race([Promise.all(pending), timeout]);
    for (const conn of this.#connections) conn.terminate();
    this.#wss.close();
  }

  async #serve(conn: Connection, requestHost: string | undefined): Promise<void> {
    const releaseUnauthenticated = this.#trackUnauthenticated(conn.ipKey);
    conn.onClose(releaseUnauthenticated);
    let session: AuthedSession;
    try {
      session = await runHandshake(conn, {
        db: this.#deps.db,
        dataDir: this.#deps.dataDir,
        serverKeyId: this.#deps.serverKeyId,
        limits: this.#deps.limits,
        now: this.#deps.now,
        challenges: this.#challenges,
        authFailures: this.#authFailures,
        newIdentities: this.#newIdentities,
        logger: this.#deps.logger,
        realAddresses: this.#addressing.real,
      });
    } catch (e) {
      if (!(e instanceof HandshakeFailed)) {
        this.#deps.logger.error('handshake crashed', { error: String(e) });
        conn.close('INTERNAL');
      }
      return;
    } finally {
      this.#challenges.drop(conn.id);
      releaseUnauthenticated();
    }
    if (this.#closing) {
      conn.close('SERVER_SHUTDOWN');
      return;
    }
    await this.#runSession(conn, session, requestHost);
  }

  async #runSession(conn: Connection, session: AuthedSession, requestHost: string | undefined): Promise<void> {
    const { modules, logger } = this.#deps;
    const handle: SessionHandle = {
      userId: session.userId,
      sessionId: session.sessionId,
      send: (event) => conn.send(event),
      terminate: (code) => conn.close(code),
    };
    const info: SessionInfo = { userId: session.userId, sessionId: session.sessionId };
    this.sessions.add(handle); // closes an older session of the same identity with SESSION_REPLACED
    conn.onClose(() => this.sessions.ended(handle, conn.closeCode ?? 'disconnected'));

    // Everything from here to sessions.opened() is synchronous, so no event can reach
    // this socket before its welcome.
    let extras: Record<string, unknown>;
    try {
      extras = modules.welcome(info);
    } catch (e) {
      logger.error('welcome failed', { error: String(e) });
      conn.close('INTERNAL');
      return;
    }
    const meta = getMeta(this.#deps.db);
    const welcome: WelcomePayload & Record<string, unknown> = {
      self: { userId: session.userId, nickname: session.nickname, isOwner: session.isOwner },
      sessionId: session.sessionId,
      serverTime: this.#deps.now(),
      server: { name: meta.name, version: this.#deps.version, joinMode: meta.joinMode, serverKeyId: this.#deps.serverKeyId },
      features: [...modules.features],
      fileToken: session.fileToken,
      protocol: { min: PROTOCOL.min, max: PROTOCOL.max },
      ...extras, // ModuleHost.welcome() refuses M1 keys
    };
    conn.send({ t: 'welcome', d: welcome });
    this.sessions.opened(handle);

    const requestContext: RequestContext = {
      ...modules.context,
      userId: session.userId,
      sessionId: session.sessionId,
      requestHost,
      isCurrent: () => this.sessions.isCurrent(handle),
    };
    const perSecond = new SlidingWindowLimiter(this.#deps.limits.requestsPerSecondPerSession, 1_000, this.#deps.now);
    for (;;) {
      let envelope: Envelope;
      try {
        envelope = await conn.nextEnvelope();
      } catch (e) {
        if (e instanceof ProtocolError) conn.close('BAD_REQUEST');
        else if (!(e instanceof ConnectionClosedError)) throw e;
        return;
      }
      if (!this.sessions.isCurrent(handle)) return;
      if (envelope.id !== undefined && !perSecond.hit('requests')) {
        conn.send(errorResponse(envelope.id, 'RATE_LIMITED'));
        continue;
      }
      const response = await this.#dispatch(requestContext, envelope);
      // Re-check after the await: the session may have been replaced or closed meanwhile (spec §5.1).
      if (response && this.sessions.isCurrent(handle)) conn.send(response);
    }
  }

  /** Counts a connection as unauthenticated until the returned function runs (idempotent). */
  #trackUnauthenticated(key: string): () => void {
    this.#unauthenticated++;
    this.#unauthenticatedPerIp.set(key, (this.#unauthenticatedPerIp.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#unauthenticated--;
      const left = (this.#unauthenticatedPerIp.get(key) ?? 1) - 1;
      if (left > 0) this.#unauthenticatedPerIp.set(key, left);
      else this.#unauthenticatedPerIp.delete(key);
    };
  }
}
