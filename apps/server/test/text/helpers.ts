import { afterEach } from 'vitest';
import {
  PROTOCOL,
  buildAuthMessage,
  challengeSchemaClient,
  textWelcomeSchemaClient,
  type Envelope,
  type ErrorCode,
  type TextWelcome,
} from '@ghostlink/shared';
import type { ServerModule, StartServerOptions } from '../../src/index.js';
import { createTextModule, type TextModule, type TextModuleOptions } from '../../src/text/index.js';
import { connectRaw, makeIdentity, startTestServer, type RawClient, type TestServer } from '../helpers/testClient.js';

/** A test client that keeps every event in order, so tests can assert both presence and absence. */
export interface TextClient {
  userId: string;
  seed: Uint8Array;
  nickname: string;
  welcome: Record<string, unknown>;
  text: TextWelcome;
  events: Envelope[];
  /** The `error` event sent before the server closed this session, if any. */
  closedWith: ErrorCode | null;
  closed: Promise<{ code: number; reason: string }>;
  request(t: string, d?: unknown): Promise<{ ok: boolean; d?: unknown; error?: { code: ErrorCode } }>;
  /** The response data; throws when the server answered with an error. */
  ok<T = Record<string, unknown>>(t: string, d?: unknown): Promise<T>;
  /** The error code; throws when the request succeeded. */
  fail(t: string, d?: unknown): Promise<ErrorCode>;
  /** Waits for an event of type `t` (already received or future) matching `pred`. */
  event<T = Record<string, unknown>>(t: string, pred?: (d: T) => boolean, timeoutMs?: number): Promise<T>;
  /** A ping round trip: afterwards every event the server sent earlier is in `events`. */
  sync(): Promise<void>;
  /** Events of type `t` received so far. */
  seen<T = Record<string, unknown>>(t: string): T[];
  clear(): void;
  close(): void;
}

export interface JoinOptions {
  nickname?: string;
  seed?: Uint8Array;
  inviteCode?: string;
  password?: string;
  setupCode?: string;
}

export type JoinResult = { client: TextClient; error?: undefined } | { client?: undefined; error: ErrorCode };

let counter = 0;

/** Full handshake over a pinned WSS; resolves with the client or the refusal code. */
export async function joinServer(server: TestServer['server'], opts: JoinOptions = {}): Promise<JoinResult> {
  const identity = makeIdentity(opts.seed);
  const nickname = opts.nickname ?? `user${++counter}`;
  const raw = await connectRaw(server);
  const hello: Record<string, unknown> = {
    protocol: PROTOCOL.current,
    publicKey: identity.publicKey,
    nickname,
    locale: 'pt-BR',
    client: 'ghostlink-test/0.0.0 (test)',
  };
  for (const key of ['inviteCode', 'password', 'setupCode'] as const) if (opts[key] !== undefined) hello[key] = opts[key];
  raw.send({ t: 'hello', d: hello });
  let m = await raw.next();
  if (m.t === 'challenge') {
    const { nonce } = challengeSchemaClient.parse(m.d);
    raw.send({ t: 'auth.proof', d: { signature: Buffer.from(identity.sign(buildAuthMessage(server.serverKeyId, nonce))).toString('base64url') } });
    m = await raw.next();
  }
  if (m.t === 'error') {
    raw.close();
    return { error: (m.d as { code: ErrorCode }).code };
  }
  if (m.t !== 'welcome') throw new Error(`unexpected ${m.t}`);
  return { client: wrapClient(raw, m.d as Record<string, unknown>, { userId: identity.userId, seed: identity.seed, nickname }) };
}

/** A TextClient over a socket that just received its welcome (a person's or a bot's). */
export function wrapClient(raw: RawClient, welcome: Record<string, unknown>, who: { userId: string; seed: Uint8Array; nickname: string }): TextClient {
  const events: Envelope[] = [];
  const pending = new Map<number, (r: { ok: boolean; d?: unknown; error?: { code: ErrorCode } }) => void>();
  const listeners = new Set<() => void>();
  let nextId = 1;
  const client: TextClient = {
    userId: who.userId,
    seed: who.seed,
    nickname: who.nickname,
    welcome,
    text: textWelcomeSchemaClient.parse(welcome),
    events,
    closedWith: null,
    closed: raw.closed,
    request: (t, d = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`no response to ${t}`)), 5_000);
      pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      raw.send({ t, id, d });
    }),
    ok: async <T>(t: string, d?: unknown) => {
      const r = await client.request(t, d);
      if (!r.ok) throw new Error(`${t} failed with ${r.error?.code}`);
      return r.d as T;
    },
    fail: async (t, d) => {
      const r = await client.request(t, d);
      if (r.ok) throw new Error(`${t} unexpectedly succeeded: ${JSON.stringify(r.d)}`);
      return r.error!.code;
    },
    event: <T>(t: string, pred: (d: T) => boolean = () => true, timeoutMs = 3_000) => new Promise<T>((resolve, reject) => {
      const find = () => events.find((e) => e.t === t && pred(e.d as T));
      const found = find();
      if (found) return resolve(found.d as T);
      const check = () => {
        const e = find();
        if (!e) return;
        cleanup();
        resolve(e.d as T);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`no ${t} event within ${timeoutMs} ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(check);
      };
      listeners.add(check);
    }),
    sync: async () => {
      await client.ok('ping');
    },
    seen: <T>(t: string) => events.filter((e) => e.t === t).map((e) => e.d as T),
    clear: () => {
      events.length = 0;
    },
    close: () => raw.close(),
  };
  void (async () => {
    for (;;) {
      let e: Envelope;
      try {
        e = await raw.next(24 * 3_600_000);
      } catch {
        return;
      }
      if (e.t === 'res') {
        const r = e as unknown as { id: number; ok: boolean; d?: unknown; error?: { code: ErrorCode } };
        pending.get(r.id)?.(r);
        pending.delete(r.id);
        continue;
      }
      if (e.t === 'error') client.closedWith = (e.d as { code: ErrorCode }).code;
      events.push(e);
      for (const l of [...listeners]) l();
    }
  })();
  return client;
}

export interface TextFixture {
  t: TestServer;
  text: TextModule;
  owner: TextClient;
  /** The fake clock (ms). Advance it with `clock.now += …`. */
  clock: { now: number };
  /** Joins a new member (open mode by default) and returns them, failing the test on refusal. */
  join(opts?: JoinOptions): Promise<TextClient>;
  /** Joins and returns the refusal code, failing the test if admitted. */
  refused(opts?: JoinOptions): Promise<ErrorCode>;
}

const fixtures: Array<{ t: TestServer; clients: TextClient[] }> = [];

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const c of f.clients) c.close();
    await f.t.cleanup();
  }
});

/**
 * A real server with the text module, a fake clock and relaxed M1 limits (many
 * identities from 127.0.0.1). The owner is connected through the setup code.
 */
export async function textFixture(
  opts: { joinMode?: StartServerOptions['joinMode']; text?: TextModuleOptions; limits?: StartServerOptions['limits']; extraModules?: ServerModule[] } = {},
): Promise<TextFixture> {
  const clock = { now: Date.UTC(2026, 8, 28, 12) };
  const text = createTextModule(opts.text);
  const t = await startTestServer({
    joinMode: opts.joinMode ?? 'open',
    modules: [text, ...(opts.extraModules ?? [])],
    now: () => clock.now,
    limits: { newIdentitiesPerIpPerHour: 1_000, requestsPerSecondPerSession: 10_000, presenceGraceMs: 50, ...opts.limits },
  });
  const entry = { t, clients: [] as TextClient[] };
  fixtures.push(entry);
  const join = async (o: JoinOptions = {}) => {
    const r = await joinServer(t.server, o);
    if (!r.client) throw new Error(`join refused: ${r.error}`);
    entry.clients.push(r.client);
    return r.client;
  };
  const refused = async (o: JoinOptions = {}) => {
    const r = await joinServer(t.server, o);
    if (r.client) {
      entry.clients.push(r.client);
      throw new Error('join unexpectedly admitted');
    }
    return r.error;
  };
  const owner = await join({ nickname: 'Dono', setupCode: t.server.setupCode()! });
  return { t, text, owner, clock, join, refused };
}

/** The id of the seeded channel of that type (first by position). */
export function channelId(c: TextClient, name: string): string {
  const ch = c.text.channels.find((x) => x.name === name);
  if (!ch) throw new Error(`no channel ${name} in the welcome`);
  return ch.id;
}

export function roleId(c: TextClient, name: string): string {
  const r = c.text.roles.find((x) => x.name === name);
  if (!r) throw new Error(`no role ${name}`);
  return r.id;
}

let msgCounter = 0;
export function nextClientMsgId(): string {
  return `m${++msgCounter}`;
}
