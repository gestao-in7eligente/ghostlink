import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RawData, WebSocket } from 'ws';
import { ProtocolError, envelopeSchema, type Envelope, type ErrorCode } from '@ghostlink/shared';

/** Application close code; the reason string is the ErrorCode. */
export const APP_CLOSE_CODE = 4000;
/** Frames queued while the previous one is still being handled; beyond this the peer is flooding. */
export const MAX_INBOX = 64;
const CLOSE_GRACE_MS = 2_000;

export type ConnectionState = 'awaiting-hello' | 'awaiting-proof' | 'authenticated' | 'closed';

export class ConnectionClosedError extends Error {
  constructor() {
    super('connection closed');
    this.name = 'ConnectionClosedError';
  }
}

export interface ConnectionOptions {
  ip: string;
  ipKey: string;
  pingIntervalMs: number;
  pongTimeoutMs: number;
}

type InboxItem = Envelope | ProtocolError;

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/**
 * One WebSocket. Frames are parsed and validated as envelopes, then handed out
 * one at a time through `nextEnvelope()`, which gives each socket a serial
 * processing order (spec §5.1). Also owns the handshake deadline and the
 * ping/pong heartbeat (spec §5.1: ping every 15 s, drop after 30 s without pong).
 */
export class Connection {
  readonly id = randomUUID();
  readonly ip: string;
  readonly ipKey: string;
  state: ConnectionState = 'awaiting-hello';

  readonly #ws: WebSocket;
  readonly #inbox: InboxItem[] = [];
  #waiter: { resolve: (e: Envelope) => void; reject: (e: Error) => void } | null = null;
  #deadline: NodeJS.Timeout | null = null;
  #killTimer: NodeJS.Timeout | null = null;
  readonly #heartbeat: NodeJS.Timeout;
  #lastPong = performance.now();
  #socketClosed = false;
  readonly #closeListeners: Array<() => void> = [];

  constructor(ws: WebSocket, opts: ConnectionOptions) {
    this.#ws = ws;
    this.ip = opts.ip;
    this.ipKey = opts.ipKey;
    ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary));
    ws.on('pong', () => {
      this.#lastPong = performance.now();
    });
    ws.on('error', () => {
      // 'close' always follows; nothing to do here.
    });
    ws.on('close', () => this.#onSocketClosed());
    // Real monotonic time on purpose: the injected test clock may jump by minutes.
    this.#heartbeat = setInterval(() => {
      if (performance.now() - this.#lastPong > opts.pongTimeoutMs) {
        this.terminate();
        return;
      }
      if (this.#ws.readyState === this.#ws.OPEN) this.#ws.ping();
    }, opts.pingIntervalMs);
    this.#heartbeat.unref();
  }

  /** Resolves with the next valid envelope; rejects with ProtocolError for an invalid frame or ConnectionClosedError. */
  nextEnvelope(): Promise<Envelope> {
    if (this.state === 'closed') return Promise.reject(new ConnectionClosedError());
    if (this.#waiter) return Promise.reject(new Error('nextEnvelope() is already pending'));
    const item = this.#inbox.shift();
    if (item instanceof ProtocolError) return Promise.reject(item);
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<Envelope>((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  send(envelope: object): void {
    if (this.state !== 'closed') this.#write(envelope);
  }

  /** Sends `error { code, ...extra }`, then closes with APP_CLOSE_CODE and the code as reason. Idempotent. */
  close(code: ErrorCode, extra?: { min?: number; max?: number }): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.clearDeadline();
    this.#write({ t: 'error', d: { code, ...extra } });
    this.#ws.close(APP_CLOSE_CODE, code);
    this.#killTimer = setTimeout(() => this.#ws.terminate(), CLOSE_GRACE_MS);
    this.#killTimer.unref();
    this.#rejectWaiter();
  }

  /** Drops the socket without a goodbye (unresponsive peer). */
  terminate(): void {
    this.state = 'closed';
    this.clearDeadline();
    this.#ws.terminate();
    this.#rejectWaiter();
  }

  /** Runs `onExpire` unless cleared or replaced within `ms`. */
  setDeadline(ms: number, onExpire: () => void): void {
    this.clearDeadline();
    this.#deadline = setTimeout(() => {
      this.#deadline = null;
      if (this.state !== 'closed') onExpire();
    }, ms);
    this.#deadline.unref();
  }

  clearDeadline(): void {
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#deadline = null;
  }

  /** Called once when the socket is fully closed (immediately if it already is). */
  onClose(listener: () => void): void {
    if (this.#socketClosed) queueMicrotask(listener);
    else this.#closeListeners.push(listener);
  }

  /** True once close()/terminate() ran or the socket closed (a getter, so TS does not narrow it away). */
  get closed(): boolean {
    return this.state === 'closed';
  }

  get socketClosed(): boolean {
    return this.#socketClosed;
  }

  #write(envelope: object): void {
    if (this.#ws.readyState === this.#ws.OPEN) this.#ws.send(JSON.stringify(envelope));
  }

  #onMessage(data: RawData, isBinary: boolean): void {
    if (this.state === 'closed') return;
    let item: InboxItem;
    if (isBinary) {
      item = new ProtocolError('BAD_REQUEST', 'binary frames are not supported');
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawToString(data));
      } catch {
        parsed = undefined;
      }
      const envelope = envelopeSchema.safeParse(parsed);
      item = envelope.success ? envelope.data : new ProtocolError('BAD_REQUEST', 'invalid envelope');
    }
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = null;
      if (item instanceof ProtocolError) waiter.reject(item);
      else waiter.resolve(item);
      return;
    }
    if (this.#inbox.length >= MAX_INBOX) {
      this.close('RATE_LIMITED');
      return;
    }
    this.#inbox.push(item);
  }

  #rejectWaiter(): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.reject(new ConnectionClosedError());
  }

  #onSocketClosed(): void {
    if (this.#socketClosed) return;
    this.#socketClosed = true;
    this.state = 'closed';
    this.clearDeadline();
    clearInterval(this.#heartbeat);
    if (this.#killTimer) clearTimeout(this.#killTimer);
    this.#inbox.length = 0;
    this.#rejectWaiter();
    for (const listener of this.#closeListeners.splice(0)) listener();
  }
}
