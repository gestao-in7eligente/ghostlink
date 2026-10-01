import { X509Certificate, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { ClientRequestArgs } from 'node:http';
import { isIP, type createConnection as netCreateConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import WebSocket from 'ws';
import {
  PROTOCOL,
  buildAuthMessage,
  challengeSchemaClient,
  errorEventSchemaClient,
  resSchemaClient,
  welcomeSchemaClient,
  type Envelope,
  type ErrorCode,
  type HelloPayload,
  type ResErr,
  type ResOk,
  type WelcomePayload,
} from '@ghostlink/shared';
import { silentLogger, startServer, type GhostServer, type StartServerOptions } from '../../src/index.js';
import { makeIdentity, type TestIdentity } from './identity.js';

export { makeIdentity, type TestIdentity } from './identity.js';

const DEFAULT_TIMEOUT_MS = 5_000;

export interface TestServer {
  server: GhostServer;
  dataDir: string;
  url: string;
  cleanup(): Promise<void>;
}

/** Real server on 127.0.0.1 and a random port, in a fresh temp data dir, with a silent logger. */
export async function startTestServer(opts: Partial<StartServerOptions> = {}): Promise<TestServer> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'ghostlink-test-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', logger: silentLogger, ...opts, dataDir });
  return {
    server,
    dataDir,
    url: `wss://127.0.0.1:${server.port}/ws`,
    cleanup: async () => {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export interface RawClient {
  ws: WebSocket;
  send(message: unknown): void;
  /** Next JSON message from the server; rejects on timeout or when the socket closes first. */
  next(timeoutMs?: number): Promise<Envelope>;
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

/**
 * Opens a WSS connection that pins the server's serverKeyId on 'secureConnect',
 * before the upgrade request is sent — the same technique as the desktop main
 * process (spec §3.3). A mismatch destroys the socket with code PIN_MISMATCH.
 */
export function connectRaw(
  server: Pick<GhostServer, 'port' | 'serverKeyId'>,
  opts: { pin?: string; autoPong?: boolean; path?: string } = {},
): Promise<RawClient> {
  const pin = opts.pin ?? server.serverKeyId;
  const ws = new WebSocket(`wss://127.0.0.1:${server.port}${opts.path ?? '/ws'}`, {
    perMessageDeflate: false,
    autoPong: opts.autoPong ?? true,
    // @types/ws types this as the overloaded net.createConnection, hence the cast.
    createConnection: ((options: ClientRequestArgs) => {
      const host = String(options.host);
      const socket = tlsConnect({
        ...(options as ConnectionOptions),
        path: undefined,
        servername: isIP(host) ? undefined : host,
        rejectUnauthorized: false,
      });
      socket.once('secureConnect', () => {
        const raw = socket.getPeerCertificate(true).raw;
        const spki = new X509Certificate(raw).publicKey.export({ type: 'spki', format: 'der' });
        const got = createHash('sha256').update(spki).digest('base64url');
        if (got !== pin) socket.destroy(Object.assign(new Error('PIN_MISMATCH'), { code: 'PIN_MISMATCH' }));
      });
      return socket;
    }) as unknown as typeof netCreateConnection,
  });

  const queue: Envelope[] = [];
  const waiters: Array<(m: Envelope | null) => void> = [];
  let isClosed = false;
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Envelope;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => {
      isClosed = true;
      for (const waiter of waiters.splice(0)) waiter(null);
      resolve({ code, reason: reason.toString() });
    });
  });

  const client: RawClient = {
    ws,
    send: (message) => ws.send(typeof message === 'string' ? message : JSON.stringify(message)),
    next: (timeoutMs = DEFAULT_TIMEOUT_MS) => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      if (isClosed) return Promise.reject(new Error('socket closed'));
      return new Promise<Envelope>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(onMessage);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`no message within ${timeoutMs} ms`));
        }, timeoutMs);
        const onMessage = (m: Envelope | null) => {
          clearTimeout(timer);
          if (m) resolve(m);
          else reject(new Error('socket closed'));
        };
        waiters.push(onMessage);
      });
    },
    closed,
    close: () => ws.close(),
  };

  return new Promise<RawClient>((resolve, reject) => {
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}

export interface TestClient {
  identity: TestIdentity;
  welcome?: WelcomePayload;
  /** The welcome exactly as sent, including module fields (the client schema strips unknown keys). */
  rawWelcome?: Record<string, unknown>;
  error?: { code: ErrorCode; min?: number; max?: number; at?: number };
  raw: RawClient;
  request(t: string, d?: unknown): Promise<ResOk | ResErr>;
  waitEvent(t: string, timeoutMs?: number): Promise<Envelope>;
  close(): void;
}

export interface ConnectTestClientOptions {
  seed?: Uint8Array;
  nickname?: string;
  inviteCode?: string;
  password?: string;
  setupCode?: string;
  protocol?: number;
  locale?: string;
}

/**
 * Runs the full handshake. Resolves with `welcome` set on success, or with
 * `error` set when the server refused (the socket is then closing).
 */
export async function connectTestClient(server: GhostServer, opts: ConnectTestClientOptions = {}): Promise<TestClient> {
  const identity = makeIdentity(opts.seed);
  const raw = await connectRaw(server);
  const hello: HelloPayload = {
    protocol: opts.protocol ?? PROTOCOL.current,
    publicKey: identity.publicKey,
    nickname: opts.nickname ?? `user-${identity.userId.slice(0, 6)}`,
    locale: opts.locale ?? 'pt-BR',
    client: 'ghostlink-test/0.0.0 (test)',
  };
  if (opts.password !== undefined) hello.password = opts.password;
  if (opts.inviteCode !== undefined) hello.inviteCode = opts.inviteCode;
  if (opts.setupCode !== undefined) hello.setupCode = opts.setupCode;
  raw.send({ t: 'hello', d: hello });

  const client: TestClient = {
    identity,
    raw,
    request: () => Promise.reject(new Error('not connected')),
    waitEvent: () => Promise.reject(new Error('not connected')),
    close: () => raw.close(),
  };

  let message = await raw.next();
  if (message.t === 'challenge') {
    const challenge = challengeSchemaClient.parse(message.d);
    // Sign the PINNED key id, never the one echoed by the server (spec §3.3).
    const signature = identity.sign(buildAuthMessage(server.serverKeyId, challenge.nonce));
    raw.send({ t: 'auth.proof', d: { signature: Buffer.from(signature).toString('base64url') } });
    message = await raw.next();
  }
  if (message.t === 'error') {
    client.error = errorEventSchemaClient.parse(message).d;
    return client;
  }
  if (message.t !== 'welcome') throw new Error(`unexpected message ${message.t}`);
  client.welcome = welcomeSchemaClient.parse(message.d);
  client.rawWelcome = message.d as Record<string, unknown>;

  // After the welcome: route responses by id, queue everything else as events.
  let nextId = 1;
  const pending = new Map<number, (r: ResOk | ResErr) => void>();
  const events: Envelope[] = [];
  const eventWaiters: Array<{ t: string; resolve: (e: Envelope) => void }> = [];
  void (async () => {
    for (;;) {
      let m: Envelope;
      try {
        m = await raw.next(24 * 3_600_000);
      } catch {
        return;
      }
      if (m.t === 'res') {
        const res = resSchemaClient.parse(m) as ResOk | ResErr;
        pending.get(res.id)?.(res);
        pending.delete(res.id);
        continue;
      }
      const i = eventWaiters.findIndex((w) => w.t === m.t);
      if (i >= 0) eventWaiters.splice(i, 1)[0]!.resolve(m);
      else events.push(m);
    }
  })();

  client.request = (t, d = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`no response to ${t}`)), DEFAULT_TIMEOUT_MS);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    raw.send({ t, id, d });
  });
  client.waitEvent = (t, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const i = events.findIndex((e) => e.t === t);
    if (i >= 0) return Promise.resolve(events.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = { t, resolve: (e: Envelope) => { clearTimeout(timer); resolve(e); } };
      const timer = setTimeout(() => {
        const j = eventWaiters.indexOf(waiter);
        if (j >= 0) eventWaiters.splice(j, 1);
        reject(new Error(`no ${t} event within ${timeoutMs} ms`));
      }, timeoutMs);
      eventWaiters.push(waiter);
    });
  };
  return client;
}
