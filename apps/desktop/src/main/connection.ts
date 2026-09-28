import { EventEmitter } from 'node:events';
import type { ClientRequestArgs } from 'node:http';
import { isIP, type createConnection as netCreateConnection } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import WebSocket from 'ws';
import {
  LIMITS,
  PROTOCOL,
  ProtocolError,
  buildAuthMessage,
  challengeSchemaClient,
  envelopeSchema,
  errorEventSchemaClient,
  formatHostPort,
  isErrorCode,
  parseHostPort,
  resSchemaClient,
  toBase64Url,
  welcomeSchemaClient,
  type Envelope,
  type HelloPayload,
  type WelcomePayload,
} from '@ghostlink/shared';
import { AppError, toAppErrorCode, type AppErrorCode } from '../shared/appErrors.js';
import type { ConnState } from '../shared/ipcTypes.js';
import type { ServerKey } from './identity.js';
import { serverKeyIdFromCertificate } from './pinning.js';

export type { ConnState } from '../shared/ipcTypes.js';

export interface ConnectionTiming {
  /** Delay between starting two addresses of the same server (spec §3.3). */
  staggerMs: number;
  /** Per-address limit for TCP + TLS + WebSocket upgrade (spec §3.3). */
  attemptTimeoutMs: number;
  /** From the upgrade to `welcome` (the server allows 5 s for hello and 10 s for the proof). */
  handshakeTimeoutMs: number;
  requestTimeoutMs: number;
  /** The server pings every 15 s (spec §5.1); silence this long means a dead link. */
  idleTimeoutMs: number;
  /** Reconnect backoff bounds (spec §13: 1 to 30 s, with jitter). */
  backoffMinMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_TIMING: ConnectionTiming = {
  staggerMs: 250,
  attemptTimeoutMs: 5_000,
  handshakeTimeoutMs: 20_000,
  requestTimeoutMs: 15_000,
  idleTimeoutMs: 45_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
};

type Hello = Omit<HelloPayload, 'publicKey' | 'protocol'>;

export interface ServerConnectionOptions {
  addresses: string[];
  serverKeyId: string;
  key: ServerKey;
  hello: Hello;
  reconnect?: boolean;
  /** Tests shorten these. */
  timing?: Partial<ConnectionTiming>;
  /** Jitter source (tests make it deterministic). */
  random?: () => number;
}

/**
 * Codes after which retrying cannot help: the user (or the server owner) must act.
 * Everything else — SERVER_SHUTDOWN, RATE_LIMITED, UNREACHABLE, CONNECTION_LOST,
 * TIMEOUT, INTERNAL and the handshake deadlines — is retried with backoff.
 */
const FATAL_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  'PIN_MISMATCH', 'PROTOCOL_UNSUPPORTED', 'SERVER_OUTDATED', 'BAD_PASSWORD', 'INVITE_REQUIRED', 'INVITE_INVALID',
  'BAD_SIGNATURE', 'BAD_SETUP_CODE', 'SERVER_FULL', 'BANNED', 'REJOIN_BLOCKED', 'NICK_TAKEN', 'SESSION_REPLACED', 'KICKED',
]);

export function isFatal(code: AppErrorCode): boolean {
  return FATAL_CODES.has(code);
}

/** Exponential backoff from backoffMinMs to backoffMaxMs with ±20 % jitter (spec §13). */
export function backoffDelay(attempt: number, random: () => number, timing: Pick<ConnectionTiming, 'backoffMinMs' | 'backoffMaxMs'> = DEFAULT_TIMING): number {
  const base = Math.min(timing.backoffMaxMs, timing.backoffMinMs * 2 ** Math.min(attempt, 30));
  const jittered = Math.round(base * (0.8 + 0.4 * random()));
  return Math.min(timing.backoffMaxMs, Math.max(timing.backoffMinMs, jittered));
}

/** Maps a server `error` event to the code shown to the user (spec §5.1: old app vs old server). */
export function errorCodeFromEvent(d: { code: AppErrorCode; min?: number; max?: number }): AppErrorCode {
  if (d.code === 'PROTOCOL_UNSUPPORTED' && d.max !== undefined && d.max < PROTOCOL.current) return 'SERVER_OUTDATED';
  return d.code;
}

function toError(code: AppErrorCode, message?: string): Error {
  return isErrorCode(code) ? new ProtocolError(code, message) : new AppError(code, message);
}

/**
 * Reads the peer's serverKeyId right after the TLS handshake. getPeerCertificate(true)
 * is called exactly once: repeated getPeerX509Certificate() calls empty the chain (spec §3.3).
 */
function peerServerKeyId(socket: TLSSocket): string | null {
  const raw = socket.getPeerCertificate(true)?.raw;
  if (!raw) return null;
  try {
    return serverKeyIdFromCertificate(raw);
  } catch {
    return null;
  }
}

function tlsHost(host: string): { host: string; servername: string | undefined } {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  // SNI only for DNS names; an IP as servername is invalid (RFC 6066).
  return { host: bare, servername: isIP(bare) === 0 ? bare : undefined };
}

/**
 * The `createConnection` hook given to ws: TLS without CA validation, then the
 * pin check on 'secureConnect' — before ws writes the HTTP upgrade request, so a
 * server with the wrong key never receives a single HTTP byte (spec §3.3).
 * Node never calls checkServerIdentity for a self-signed certificate, so it cannot hold the pin.
 */
export function pinnedTlsConnect(options: ClientRequestArgs, pin: string): TLSSocket {
  const { host, servername } = tlsHost(String(options.host ?? ''));
  const socket = tlsConnect({
    ...(options as ConnectionOptions),
    host,
    path: undefined, // a `path` option would make tls.connect open an IPC pipe
    servername,
    rejectUnauthorized: false,
  });
  socket.once('secureConnect', () => {
    if (peerServerKeyId(socket) !== pin) {
      socket.destroy(Object.assign(new Error('PIN_MISMATCH'), { code: 'PIN_MISMATCH' }));
    }
  });
  return socket;
}

/**
 * TOFU probe (spec §3.3): opens TLS without a pin, reads the serverKeyId and
 * closes without sending anything. Rejects with AppError('UNREACHABLE').
 */
export async function probeServerKeyId(address: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const target = parseHostPort(address);
  const { host, servername } = tlsHost(target.host);
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const socket = tlsConnect({ host, port: target.port, servername, rejectUnauthorized: false });
    const finish = (result: string | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (typeof result === 'string') resolve(result);
      else reject(result);
    };
    const timer = setTimeout(() => finish(new AppError('UNREACHABLE', 'timed out')), opts.timeoutMs ?? DEFAULT_TIMING.attemptTimeoutMs);
    socket.once('secureConnect', () => finish(peerServerKeyId(socket) ?? new AppError('UNREACHABLE', 'no certificate')));
    socket.once('error', (e) => finish(new AppError('UNREACHABLE', e.message)));
    socket.once('close', () => finish(new AppError('UNREACHABLE', 'closed')));
  });
}

function rawToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/** JSON text frame → raw value; anything else → undefined (clients ignore malformed frames). */
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

function codeFromClose(code: number, reason: Buffer): AppErrorCode {
  const text = reason.toString();
  return code === 4000 && isErrorCode(text) ? text : 'CONNECTION_LOST';
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * One pinned WSS session with a GhostLink server (spec §3.3, §5, §13).
 *
 * Events: 'state' (ConnState), 'welcome' (WelcomePayload, on every successful
 * handshake), 'event' (server events other than res/error) and 'fatal'
 * ({ code }) when the connection stops for good (a fatal code, or any loss
 * while reconnect is off).
 */
export class ServerConnection extends EventEmitter {
  readonly #addresses: string[];
  readonly #serverKeyId: string;
  readonly #key: ServerKey;
  readonly #reconnect: boolean;
  readonly #timing: ConnectionTiming;
  readonly #random: () => number;
  #hello: Hello;
  #state: ConnState = 'idle';
  #ws: WebSocket | null = null;
  #address: string | null = null;
  #attempts: WebSocket[] = [];
  /** The socket between the race and 'welcome', so close() can cut a handshake short. */
  #handshaking: WebSocket | null = null;
  #closedByUser = false;
  #closeReason: AppErrorCode | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #reconnectTimer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #failures = 0;

  constructor(opts: ServerConnectionOptions) {
    super();
    if (opts.addresses.length < 1 || opts.addresses.length > LIMITS.inviteMaxAddresses) {
      throw new ProtocolError('BAD_REQUEST', `a server needs 1 to ${LIMITS.inviteMaxAddresses} addresses`);
    }
    this.#addresses = opts.addresses.map((a) => {
      const { host, port } = parseHostPort(a);
      return formatHostPort(host, port);
    });
    if (!/^[A-Za-z0-9_-]{43}$/.test(opts.serverKeyId)) throw new ProtocolError('BAD_REQUEST', 'invalid serverKeyId');
    this.#serverKeyId = opts.serverKeyId;
    this.#key = opts.key;
    this.#hello = { ...opts.hello };
    this.#reconnect = opts.reconnect ?? true;
    this.#timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.#random = opts.random ?? Math.random;
  }

  get state(): ConnState {
    return this.#state;
  }

  get connectedAddress(): string | null {
    return this.#address;
  }

  /**
   * Races the addresses, runs the handshake and resolves with `welcome`. A failure
   * rejects with ProtocolError (server codes) or AppError (local codes) and leaves
   * the state 'failed'; reconnecting only starts after a first success.
   */
  async connect(): Promise<WelcomePayload> {
    if (this.#state !== 'idle' && this.#state !== 'failed') throw new AppError('BAD_REQUEST', 'already connecting or connected');
    this.#closedByUser = false;
    this.#setState('connecting');
    try {
      return await this.#establish(false);
    } catch (e) {
      if (!this.#closedByUser) this.#setState('failed');
      throw e;
    }
  }

  /** Sends a request after `welcome`; rejects with ProtocolError for a server error response. */
  request<T>(t: string, d: unknown = {}): Promise<T> {
    const ws = this.#ws;
    if (this.#state !== 'connected' || ws === null) return Promise.reject(new AppError('CONNECTION_LOST', 'not connected'));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AppError('TIMEOUT'));
      }, this.#timing.requestTimeoutMs);
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ t, id, d }));
    });
  }

  /** Stops everything (including reconnecting) and goes back to 'idle'. */
  close(): void {
    this.#closedByUser = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    for (const attempt of this.#attempts.splice(0)) attempt.terminate();
    this.#handshaking?.terminate();
    const ws = this.#ws;
    this.#detach();
    ws?.close(1000);
    this.#setState('idle');
  }

  // ---- connecting ----

  async #establish(reconnecting: boolean): Promise<WelcomePayload> {
    const { ws, address } = await this.#race();
    if (this.#closedByUser) {
      ws.terminate();
      throw new AppError('CONNECTION_LOST', 'closed');
    }
    if (!reconnecting) this.#setState('authenticating');
    this.#handshaking = ws;
    let welcome: WelcomePayload;
    try {
      welcome = await this.#handshake(ws);
    } finally {
      this.#handshaking = null;
    }
    if (this.#closedByUser) {
      ws.close(1000);
      throw new AppError('CONNECTION_LOST', 'closed');
    }
    this.#attach(ws, address);
    this.#failures = 0;
    // Credentials are for the first entry only; members reconnect without them (spec §3.3).
    const { password: _password, inviteCode: _inviteCode, setupCode: _setupCode, ...rest } = this.#hello;
    this.#hello = rest;
    this.#setState('connected');
    this.emit('welcome', welcome);
    return welcome;
  }

  /** Tries every address (a new one every staggerMs) and keeps the first that passes the pin and upgrades. */
  #race(): Promise<{ ws: WebSocket; address: string }> {
    return new Promise((resolve, reject) => {
      const failures: AppErrorCode[] = [];
      let started = 0;
      let settled = false;
      let stagger: NodeJS.Timeout | null = null;

      const settle = (error: Error | null, winner?: { ws: WebSocket; address: string }) => {
        if (settled) return;
        settled = true;
        if (stagger) clearInterval(stagger);
        for (const attempt of this.#attempts.splice(0)) if (attempt !== winner?.ws) attempt.terminate();
        if (winner) resolve(winner);
        else reject(error);
      };

      const startNext = () => {
        if (settled || started >= this.#addresses.length) return;
        const address = this.#addresses[started++]!;
        const ws = this.#open(address);
        this.#attempts.push(ws);
        let failed = false;
        const fail = (code: AppErrorCode) => {
          if (failed) return;
          failed = true;
          clearTimeout(limit);
          failures.push(code);
          if (settled) return;
          if (failures.length === this.#addresses.length) {
            settle(new AppError(failures.includes('PIN_MISMATCH') ? 'PIN_MISMATCH' : 'UNREACHABLE'));
          } else if (failures.length === started) {
            startNext(); // everything started so far failed: do not wait for the stagger
          }
        };
        const limit = setTimeout(() => {
          fail('UNREACHABLE');
          ws.terminate();
        }, this.#timing.attemptTimeoutMs);
        ws.once('open', () => {
          clearTimeout(limit);
          if (settled || failed) ws.terminate();
          else settle(null, { ws, address });
        });
        ws.once('error', (e: Error & { code?: unknown }) => fail(e.code === 'PIN_MISMATCH' ? 'PIN_MISMATCH' : 'UNREACHABLE'));
        ws.once('close', () => fail('UNREACHABLE'));
      };

      startNext();
      stagger = setInterval(() => {
        startNext();
        if (started >= this.#addresses.length && stagger) clearInterval(stagger);
      }, this.#timing.staggerMs);
    });
  }

  #open(address: string): WebSocket {
    const pin = this.#serverKeyId;
    const ws = new WebSocket(`wss://${address}/ws`, {
      perMessageDeflate: false,
      maxPayload: LIMITS.maxPayloadBytes,
      handshakeTimeout: this.#timing.attemptTimeoutMs,
      // @types/ws types this as the overloaded net.createConnection, hence the cast.
      createConnection: ((options: ClientRequestArgs) => pinnedTlsConnect(options, pin)) as unknown as typeof netCreateConnection,
    });
    // A socket error is always followed by 'close', which is where failures are handled;
    // this listener only keeps an 'error' without listeners from crashing the main process.
    ws.on('error', () => {});
    return ws;
  }

  /** hello → challenge → auth.proof → welcome | error (spec §3.3). */
  #handshake(ws: WebSocket): Promise<WelcomePayload> {
    return new Promise((resolve, reject) => {
      let step: 'challenge' | 'welcome' = 'challenge';
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('close', onClose);
      };
      const fail = (error: Error) => {
        cleanup();
        ws.terminate();
        reject(error);
      };
      const timer = setTimeout(() => fail(new AppError('TIMEOUT', 'handshake timed out')), this.#timing.handshakeTimeoutMs);
      const onClose = (code: number, reason: Buffer) => fail(toError(codeFromClose(code, reason)));
      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        const frame = parseFrame(data, isBinary);
        if (!frame) return fail(new ProtocolError('BAD_REQUEST', 'the server sent an invalid frame'));
        const { raw, envelope } = frame;
        if (envelope.t === 'error') {
          const event = errorEventSchemaClient.safeParse(raw);
          return fail(toError(event.success ? errorCodeFromEvent(event.data.d) : 'INTERNAL'));
        }
        if (step === 'challenge' && envelope.t === 'challenge') {
          const challenge = challengeSchemaClient.safeParse(envelope.d);
          if (!challenge.success) return fail(new ProtocolError('BAD_REQUEST', 'invalid challenge'));
          // Sign the PINNED serverKeyId (checked against the certificate on this very
          // socket), never the value the server echoes: that binds the proof to this TLS key.
          const signature = this.#key.sign(buildAuthMessage(this.#serverKeyId, challenge.data.nonce));
          ws.send(JSON.stringify({ t: 'auth.proof', d: { signature: toBase64Url(signature) } }));
          step = 'welcome';
          return;
        }
        if (step === 'welcome' && envelope.t === 'welcome') {
          const welcome = welcomeSchemaClient.safeParse(envelope.d);
          if (!welcome.success) return fail(new ProtocolError('BAD_REQUEST', 'invalid welcome'));
          cleanup();
          resolve(welcome.data);
          return;
        }
        fail(new ProtocolError('BAD_REQUEST', `unexpected ${envelope.t}`));
      };
      ws.on('message', onMessage);
      ws.on('close', onClose);
      const hello: HelloPayload = { ...this.#hello, protocol: PROTOCOL.current, publicKey: toBase64Url(this.#key.publicKeyRaw) };
      ws.send(JSON.stringify({ t: 'hello', d: hello }));
    });
  }

  // ---- connected ----

  #attach(ws: WebSocket, address: string): void {
    this.#ws = ws;
    this.#address = address;
    this.#closeReason = null;
    ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary));
    ws.on('ping', () => this.#touch());
    ws.on('close', (code, reason) => this.#onClosed(ws, code, reason));
    this.#touch();
  }

  #detach(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#ws = null;
    this.#address = null;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new AppError('CONNECTION_LOST'));
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
    if (!frame) return; // clients ignore what they cannot parse (spec §5.1)
    const { raw, envelope } = frame;
    if (envelope.t === 'res') {
      const res = resSchemaClient.safeParse(raw);
      if (!res.success) return;
      const pending = this.#pending.get(res.data.id);
      if (!pending) return;
      this.#pending.delete(res.data.id);
      clearTimeout(pending.timer);
      if (res.data.ok) pending.resolve(res.data.d);
      else pending.reject(new ProtocolError(res.data.error.code, res.data.error.message));
      return;
    }
    if (envelope.t === 'error') {
      // Sent right before the server closes (KICKED, BANNED, SESSION_REPLACED, SERVER_SHUTDOWN…).
      const event = errorEventSchemaClient.safeParse(raw);
      this.#closeReason = event.success ? errorCodeFromEvent(event.data.d) : 'INTERNAL';
      return;
    }
    this.emit('event', envelope);
  }

  #onClosed(ws: WebSocket, code: number, reason: Buffer): void {
    if (ws !== this.#ws) return;
    const cause = this.#closeReason ?? codeFromClose(code, reason);
    this.#detach();
    if (this.#closedByUser) return;
    if (!this.#reconnect || isFatal(cause)) {
      this.#stop(cause);
      return;
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    this.#setState('reconnecting');
    const delay = backoffDelay(this.#failures++, this.#random, this.#timing);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#establish(true).catch((e: unknown) => {
        if (this.#closedByUser) return;
        const code = toAppErrorCode(e);
        if (isFatal(code)) this.#stop(code);
        else this.#scheduleReconnect();
      });
    }, delay);
  }

  #stop(code: AppErrorCode): void {
    this.#setState('failed');
    this.emit('fatal', { code });
  }

  #setState(state: ConnState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.emit('state', state);
  }
}
