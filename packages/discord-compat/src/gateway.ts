/**
 * One pinned WSS session of a bot with its GhostLink server (bots spec §2, §4): the bot hello,
 * requests and events, the server's pings, and reconnecting by itself. Built like the desktop's
 * ServerConnection (apps/desktop/src/main/connection.ts), with a bot's hello and no address race.
 */
import { EventEmitter } from 'node:events';
import type { ClientRequestArgs } from 'node:http';
import type { createConnection as netCreateConnection } from 'node:net';
import process from 'node:process';
import WebSocket from 'ws';
import {
  PROTOCOL,
  envelopeSchema,
  errorEventSchemaClient,
  formatHostPort,
  isErrorCode,
  resSchemaClient,
  welcomeSchemaClient,
  type BotHelloPayload,
  type Envelope,
} from '@ghostlink/shared';
import type { ConnectionCode } from './connectionCode.js';
import { GhostLinkError } from './errors.js';
import { pinnedTlsConnect } from './pinning.js';
import { version } from './version.js';

export interface GatewayTiming {
  /** TCP + TLS + WebSocket upgrade. */
  attemptTimeoutMs: number;
  /** From the upgrade to `welcome`. */
  handshakeTimeoutMs: number;
  requestTimeoutMs: number;
  /** The server pings every 15 s; silence this long means a dead link. */
  idleTimeoutMs: number;
  /** Reconnect backoff bounds (spec §13: 1 to 30 s, with jitter). */
  backoffMinMs: number;
  backoffMaxMs: number;
  /** How often the bot measures its round trip (`client.ws.ping`). */
  pingIntervalMs: number;
  /** A session that lasted this long resets the backoff. */
  stableSessionMs: number;
}

export const DEFAULT_TIMING: GatewayTiming = {
  attemptTimeoutMs: 10_000,
  handshakeTimeoutMs: 20_000,
  requestTimeoutMs: 15_000,
  idleTimeoutMs: 45_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  pingIntervalMs: 15_000,
  stableSessionMs: 30_000,
};

/** As the desktop: frames from the pinned server may exceed the 256 KiB the server accepts. */
const MAX_INBOUND_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Codes after which retrying cannot help: someone must act (copy a new code, update the server,
 * unban the bot). Everything else (SERVER_SHUTDOWN, SESSION_REPLACED, RATE_LIMITED, UNREACHABLE,
 * CONNECTION_LOST, TIMEOUT, INTERNAL) is retried with backoff.
 */
const FATAL_CODES: ReadonlySet<string> = new Set([
  'PIN_MISMATCH', 'BAD_BOT_TOKEN', 'PROTOCOL_UNSUPPORTED', 'BAD_REQUEST', 'BANNED', 'KICKED', 'REJOIN_BLOCKED',
  'SERVER_DELETING', 'SERVER_DELETED',
]);

const EXPLAIN: Readonly<Record<string, string>> = {
  PIN_MISMATCH: "the server's TLS key does not match the pin in the connection code; nothing was sent. Copy the code again from the app",
  BAD_BOT_TOKEN: 'the server does not know this connection code: a new code was generated or the bot was deleted. Create a new code in the app (BOTS)',
  PROTOCOL_UNSUPPORTED: 'the server speaks another protocol version: bots need a GhostLink 0.4.0 server or newer',
  BAD_REQUEST: "the server refused the bot's hello: bots need a GhostLink 0.4.0 server or newer",
  BANNED: 'the bot is banned from this server',
  KICKED: 'the bot was kicked from this server',
  REJOIN_BLOCKED: 'the bot was kicked from this server and cannot come back yet',
  SERVER_DELETING: 'the server is being deleted',
  SERVER_DELETED: 'the server was deleted',
  RATE_LIMITED: 'too many failed attempts from this address; wait a minute',
};

/** Exponential backoff from backoffMinMs to backoffMaxMs with ±20 % jitter (spec §13). */
export function backoffDelay(attempt: number, random: () => number, timing: Pick<GatewayTiming, 'backoffMinMs' | 'backoffMaxMs'>): number {
  const base = Math.min(timing.backoffMaxMs, timing.backoffMinMs * 2 ** Math.min(attempt, 30));
  const jittered = Math.round(base * (0.8 + 0.4 * random()));
  return Math.min(timing.backoffMaxMs, Math.max(timing.backoffMinMs, jittered));
}

function failure(code: string, detail?: string): GhostLinkError {
  return new GhostLinkError(code, EXPLAIN[code] ?? detail);
}

function rawToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/** JSON text frame → raw value and envelope; anything else → undefined (clients ignore malformed frames). */
function parseFrame(data: WebSocket.RawData, isBinary: boolean): { raw: unknown; envelope: Envelope } | undefined {
  if (isBinary) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(rawToString(data));
  } catch {
    return undefined;
  }
  const envelope = envelopeSchema.safeParse(raw);
  return envelope.success ? { raw, envelope: envelope.data } : undefined;
}

function codeFromClose(code: number, reason: Buffer): string {
  const text = reason.toString();
  return code === 4000 && isErrorCode(text) ? text : 'CONNECTION_LOST';
}

interface Handshake {
  welcome: Record<string, unknown>;
  /** Frames received after the welcome, before release(). */
  backlog: Array<[WebSocket.RawData, boolean]>;
  /** Removes the handshake's listener. */
  release(): void;
}

interface Pending {
  t: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export type GatewayState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

/**
 * Events: 'welcome' (the raw welcome payload, on every handshake), 'event' (server events other
 * than res/error), 'fatal' (GhostLinkError: stopped for good), 'debug' and 'warn' (string).
 * One login per Gateway: after close() or a fatal error, make a new one.
 * @internal
 */
export class Gateway extends EventEmitter {
  readonly #code: ConnectionCode;
  readonly #reconnect: boolean;
  readonly #timing: GatewayTiming;
  readonly #random: () => number;
  #state: GatewayState = 'idle';
  #ws: WebSocket | null = null;
  /** The socket between `new WebSocket` and 'welcome', so close() can cut it short. */
  #attempt: WebSocket | null = null;
  #closedByUser = false;
  #closeReason: string | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #reconnectTimer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #pingTimer: NodeJS.Timeout | null = null;
  #pingSentAt = 0;
  #ping = -1;
  #failures = 0;
  #connectedAt = 0;

  constructor(code: ConnectionCode, opts: { reconnect?: boolean; timing?: Partial<GatewayTiming>; random?: () => number } = {}) {
    super();
    this.#code = code;
    this.#reconnect = opts.reconnect ?? true;
    this.#timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.#random = opts.random ?? Math.random;
  }

  get state(): GatewayState {
    return this.#state;
  }

  /** The last WebSocket round trip in ms, -1 before the first. */
  get ping(): number {
    return this.#ping;
  }

  /** Connects and resolves with the welcome. A first failure rejects (GhostLinkError) and ends the Gateway. */
  async connect(): Promise<Record<string, unknown>> {
    if (this.#state !== 'idle') throw new GhostLinkError('BAD_REQUEST', 'this gateway was already used');
    this.#state = 'connecting';
    try {
      return await this.#establish();
    } catch (e) {
      this.#state = 'closed';
      throw e;
    }
  }

  /** A request after the welcome; rejects with GhostLinkError for a server error response. */
  request<T>(t: string, d: unknown = {}): Promise<T> {
    const ws = this.#ws;
    if (this.#state !== 'connected' || ws === null) {
      return Promise.reject(new GhostLinkError('CONNECTION_LOST', 'the bot is not connected to the server', t));
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new GhostLinkError('TIMEOUT', `no answer to ${t}`, t));
      }, this.#timing.requestTimeoutMs);
      this.#pending.set(id, { t, resolve: resolve as (value: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ t, id, d }));
    });
  }

  /** Stops everything, reconnecting included. */
  close(): void {
    this.#closedByUser = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#attempt?.terminate();
    this.#attempt = null;
    const ws = this.#ws;
    this.#detach();
    ws?.close(1000);
    this.#state = 'closed';
  }

  // ---- connecting ----

  async #establish(): Promise<Record<string, unknown>> {
    const ws = await this.#open();
    let handshake: Handshake;
    try {
      handshake = await this.#handshake(ws);
    } finally {
      if (this.#attempt === ws) this.#attempt = null;
    }
    // Synchronous from here: no frame can slip between the handshake's listener and the session's.
    handshake.release();
    if (this.#closedByUser || ws.readyState !== WebSocket.OPEN) {
      ws.terminate();
      throw new GhostLinkError('CONNECTION_LOST', 'closed right after the welcome');
    }
    this.#attach(ws);
    this.#state = 'connected';
    this.emit('welcome', handshake.welcome);
    for (const [data, isBinary] of handshake.backlog) this.#onMessage(data, isBinary);
    return handshake.welcome;
  }

  /** TCP + TLS (pin checked before any HTTP byte) + upgrade. */
  #open(): Promise<WebSocket> {
    const { host, port, pin } = this.#code;
    const address = formatHostPort(host, port);
    return new Promise((resolve, reject) => {
      if (this.#closedByUser) return reject(new GhostLinkError('CONNECTION_LOST', 'closed'));
      const ws = new WebSocket(`wss://${address}/ws`, {
        perMessageDeflate: false,
        maxPayload: MAX_INBOUND_FRAME_BYTES,
        handshakeTimeout: this.#timing.attemptTimeoutMs,
        // @types/ws types this as the overloaded net.createConnection, hence the cast.
        createConnection: ((options: ClientRequestArgs) => pinnedTlsConnect(options, pin)) as unknown as typeof netCreateConnection,
      });
      this.#attempt = ws;
      let settled = false;
      let pinMismatch = false;
      let lastError = 'closed';
      const settle = (error: GhostLinkError | null) => {
        if (settled) return;
        settled = true;
        if (error === null) return resolve(ws);
        if (this.#attempt === ws) this.#attempt = null;
        ws.terminate();
        reject(error);
      };
      // An 'error' is always followed by 'close'; this listener also keeps a late error from
      // crashing the bot's process.
      ws.on('error', (e: Error & { code?: unknown }) => {
        if (e.code === 'PIN_MISMATCH') pinMismatch = true;
        lastError = e.message;
      });
      ws.once('close', () => settle(pinMismatch ? failure('PIN_MISMATCH') : new GhostLinkError('UNREACHABLE', `${address}: ${lastError}`)));
      ws.once('open', () => settle(null));
    });
  }

  /**
   * bot hello → welcome | error (bots spec §2: no challenge for a bot). Frames that arrive after
   * the welcome, before the session takes over (ws emits every frame of a TCP chunk at once), wait
   * in `backlog`.
   */
  #handshake(ws: WebSocket): Promise<Handshake> {
    return new Promise((resolve, reject) => {
      let welcomed = false;
      const backlog: Handshake['backlog'] = [];
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('close', onClose);
      };
      const fail = (error: GhostLinkError) => {
        if (welcomed) return;
        cleanup();
        ws.terminate();
        reject(error);
      };
      const timer = setTimeout(() => fail(new GhostLinkError('TIMEOUT', 'no welcome from the server')), this.#timing.handshakeTimeoutMs);
      const onClose = (code: number, reason: Buffer) => fail(failure(codeFromClose(code, reason)));
      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        if (welcomed) {
          backlog.push([data, isBinary]);
          return;
        }
        const frame = parseFrame(data, isBinary);
        if (!frame) return fail(new GhostLinkError('INTERNAL', 'the server sent an invalid frame'));
        const { raw, envelope } = frame;
        if (envelope.t === 'error') {
          const event = errorEventSchemaClient.safeParse(raw);
          return fail(failure(event.success ? event.data.d.code : 'INTERNAL'));
        }
        if (envelope.t === 'welcome') {
          if (!welcomeSchemaClient.safeParse(envelope.d).success) return fail(new GhostLinkError('INTERNAL', 'the server sent an invalid welcome'));
          welcomed = true;
          clearTimeout(timer);
          ws.off('close', onClose);
          // Module keys (channels, members, botCommands…) ride along; the client reads them.
          return resolve({ welcome: envelope.d as Record<string, unknown>, backlog, release: cleanup });
        }
        // A challenge means a server without bots (before 0.4.0) took the hello for a person's.
        fail(failure('BAD_REQUEST'));
      };
      ws.on('message', onMessage);
      ws.on('close', onClose);
      const hello: BotHelloPayload = {
        protocol: PROTOCOL.current,
        bot: this.#code.token,
        client: `ghostlink-discord-compat/${version} (node ${process.versions.node})`.slice(0, 128),
      };
      ws.send(JSON.stringify({ t: 'hello', d: hello }));
    });
  }

  // ---- connected ----

  #attach(ws: WebSocket): void {
    this.#ws = ws;
    this.#closeReason = null;
    this.#connectedAt = Date.now();
    ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary));
    ws.on('ping', () => this.#touch());
    ws.on('pong', () => {
      this.#touch();
      if (this.#pingSentAt !== 0) this.#ping = Date.now() - this.#pingSentAt;
      this.#pingSentAt = 0;
    });
    ws.on('close', (code, reason) => this.#onClosed(ws, code, reason));
    this.#touch();
    this.#sendPing();
    this.#pingTimer = setInterval(() => this.#sendPing(), this.#timing.pingIntervalMs);
  }

  #sendPing(): void {
    if (this.#ws === null || this.#pingSentAt !== 0) return;
    this.#pingSentAt = Date.now();
    this.#ws.ping();
  }

  #detach(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#idleTimer = null;
    this.#pingTimer = null;
    this.#pingSentAt = 0;
    this.#ws = null;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new GhostLinkError('CONNECTION_LOST', 'the connection closed before the answer', pending.t));
      this.#pending.delete(id);
    }
  }

  #touch(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    const ws = this.#ws;
    this.#idleTimer = setTimeout(() => ws?.terminate(), this.#timing.idleTimeoutMs);
  }

  #onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    this.#touch();
    const frame = parseFrame(data, isBinary);
    if (!frame) return;
    const { raw, envelope } = frame;
    if (envelope.t === 'res') {
      const res = resSchemaClient.safeParse(raw);
      if (!res.success) return;
      const pending = this.#pending.get(res.data.id);
      if (!pending) return;
      this.#pending.delete(res.data.id);
      clearTimeout(pending.timer);
      if (res.data.ok) pending.resolve(res.data.d);
      else pending.reject(new GhostLinkError(res.data.error.code, res.data.error.message, pending.t));
      return;
    }
    if (envelope.t === 'error') {
      // Sent right before the server closes (BAD_BOT_TOKEN after a new code, SESSION_REPLACED…).
      const event = errorEventSchemaClient.safeParse(raw);
      this.#closeReason = event.success ? event.data.d.code : 'INTERNAL';
      return;
    }
    this.emit('event', envelope);
  }

  #onClosed(ws: WebSocket, code: number, reason: Buffer): void {
    if (ws !== this.#ws) return;
    const cause = this.#closeReason ?? codeFromClose(code, reason);
    if (Date.now() - this.#connectedAt >= this.#timing.stableSessionMs) this.#failures = 0;
    this.#detach();
    if (this.#closedByUser) return;
    if (!this.#reconnect || FATAL_CODES.has(cause)) return this.#stop(failure(cause));
    if (cause === 'SESSION_REPLACED') this.emit('warn', 'Another process connected with this bot\'s connection code and took its session; reconnecting.');
    this.#scheduleReconnect(cause);
  }

  #scheduleReconnect(cause: string): void {
    this.#state = 'reconnecting';
    const delay = backoffDelay(this.#failures++, this.#random, this.#timing);
    this.emit('debug', `[GhostLink] connection lost (${cause}); reconnecting in ${delay} ms`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#establish().catch((e: unknown) => {
        if (this.#closedByUser) return;
        const code = e instanceof GhostLinkError ? e.code : 'INTERNAL';
        if (FATAL_CODES.has(code)) this.#stop(e instanceof GhostLinkError ? e : failure(code));
        else this.#scheduleReconnect(code);
      });
    }, delay);
  }

  #stop(error: GhostLinkError): void {
    this.#state = 'closed';
    this.emit('fatal', error);
  }
}
