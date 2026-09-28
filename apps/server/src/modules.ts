import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ErrorCode } from '@ghostlink/shared';
import type { Db } from './db/database.js';
import type { VoiceServerOptions } from './livekit/backend.js';
import type { ServerLimits } from './limits.js';
import type { Logger } from './logger.js';

/** A server → client event. Events never carry an `id` (spec §5.1). */
export interface ServerEvent {
  t: string;
  d?: unknown;
  id?: never;
}

/** An authenticated session (one per identity, spec §3.3). */
export interface SessionInfo {
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * Why a session ended: the ErrorCode the server closed it with (SESSION_REPLACED,
 * KICKED, SERVER_SHUTDOWN, RATE_LIMITED, …) or 'disconnected' when the socket
 * simply went away (client quit, network loss, heartbeat timeout).
 */
export type SessionCloseReason = ErrorCode | 'disconnected';

export interface SessionCloseInfo {
  reason: SessionCloseReason;
  /**
   * false: this session just ended (fired once per session).
   * true: the user is now fully offline — fired once per offline transition:
   * presenceGraceMs after the last session ended without a reconnect, or right
   * away when the session was ended through `sessions.closeUser()` (no grace).
   * Never fired for SESSION_REPLACED (the user is still online) nor at shutdown.
   */
  graceExpired: boolean;
}

/** What modules may do with sessions. Only current, authenticated sessions are visible. */
export interface SessionsApi {
  list(): SessionInfo[];
  /** Sends one event to one session; false when that session is gone. */
  send(sessionId: string, event: ServerEvent): boolean;
  /**
   * Sends to every session for which `filter` returns true (all when omitted);
   * returns how many received it. Channel-scoped events MUST pass a per-recipient
   * VIEW_CHANNEL filter (audience rule, spec §5.3).
   */
  broadcast(event: ServerEvent, filter?: (session: SessionInfo) => boolean): number;
  /**
   * Ends the user's session with `error { code }` (e.g. KICKED, BANNED) and skips
   * the presence grace. Also ends a pending grace. False when the user was offline.
   */
  closeUser(userId: string, code: ErrorCode): boolean;
  /** True while the user has a session or is within LIMITS.presenceGraceMs of losing it. */
  isOnlineOrInGrace(userId: string): boolean;
}

/** Feature options passed to startServer() (StartServerOptions.voice, …). */
export interface ModuleOptions {
  voice?: VoiceServerOptions;
}

/** Shared services handed to every module in init(). */
export interface ModuleContext {
  readonly db: Db;
  readonly now: () => number;
  readonly logger: Logger;
  readonly limits: Readonly<ServerLimits>;
  readonly dataDir: string;
  readonly serverKeyId: string;
  readonly sessions: SessionsApi;
  /** Feature options from startServer(); absent in unit tests that build a context by hand. */
  readonly options?: Readonly<ModuleOptions>;
  /** Another registered module, for cross-module calls; throws if `name` is not registered. */
  getModule<T extends ServerModule = ServerModule>(name: string): T;
}

/** What a request handler receives: the module context plus the calling session. */
export interface RequestContext extends ModuleContext {
  readonly userId: string;
  readonly sessionId: string;
  /** Re-check after every await (spec §5.1): false once the session was replaced or closed. */
  isCurrent(): boolean;
}

/**
 * Handles one request type. Validate `payload` with a z.strictObject schema (a
 * ZodError becomes BAD_REQUEST), throw ProtocolError for protocol errors, return
 * the response `d`. Anything else thrown becomes INTERNAL (and is logged).
 */
export type RequestHandler = (ctx: RequestContext, payload: unknown) => unknown;

/**
 * A feature plugged into the server (see MODULES.md). Every member is optional
 * except `name`. Hooks run in registration order (the built-in `core` module
 * first); stop() runs in reverse order.
 */
export interface ServerModule {
  readonly name: string;
  /** Feature flags merged into welcome.features; read at every welcome (it may be a getter). */
  readonly features?: readonly string[];
  /** Request types this module answers; a type registered twice fails startup. */
  readonly handlers?: Readonly<Record<string, RequestHandler>>;
  /** Before listen. Tables exist (migrations ran). A throw aborts startup. */
  init?(ctx: ModuleContext): void | Promise<void>;
  /** After listen. A throw aborts startup (every initialized module is stopped). */
  start?(info: { port: number }): void | Promise<void>;
  /** On close, after all sessions ended, before the database closes. Runs even if start() never ran. */
  stop?(): void | Promise<void>;
  /** Extra welcome fields for this session, computed synchronously when it opens. M1 keys may not be used. */
  welcome?(session: SessionInfo): Record<string, unknown>;
  /** After the session's welcome was sent. */
  onSessionOpened?(session: SessionInfo): void;
  /** See SessionCloseInfo for when this fires with graceExpired false/true. */
  onSessionClosed?(session: SessionInfo, info: SessionCloseInfo): void;
  /** HTTP request outside the built-in routes; return true when handled (you own `res`). */
  http?(req: IncomingMessage, res: ServerResponse): boolean;
  /** Upgrade request outside /ws (e.g. /rtc); return true when handled (you own `socket`). */
  upgrade?(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
}
