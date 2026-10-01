// The call goes on while browsing (spec 2026-10-01-chamada-continua-design.md §2, §3): the
// controller with fake connections — the one on screen and the call's — switching with and
// without a call, hanging up, a call on another server, independent reconnects, the events'
// origin and the two renderer pins.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Envelope, WelcomePayload } from '@ghostlink/shared';
import type { ConnState, ConnectionStateEvent } from '../../src/shared/ipcTypes.js';
import type { ServerConnectionOptions } from '../../src/main/connection.js';
import { ClientController, type ConnectionLike } from '../../src/main/controller.js';
import { IdentityStore } from '../../src/main/identity.js';
import type { RendererPin } from '../../src/main/pinning.js';
import { SavedServersStore } from '../../src/main/savedServers.js';
import { SettingsStore } from '../../src/main/settings.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';
import { useTempDir } from '../helpers/tempDir.js';

const keyId = () => randomBytes(32).toString('base64url');
const userId = () => randomBytes(16).toString('hex');

/** A server connection that connects at once and is driven by the test. */
class FakeConnection extends EventEmitter implements ConnectionLike {
  connectedAddress: string | null = null;
  closed = false;
  readonly requests: Array<{ type: string; payload: unknown }> = [];
  constructor(
    readonly options: ServerConnectionOptions,
    readonly welcome: WelcomePayload,
  ) {
    super();
  }
  async connect(): Promise<WelcomePayload> {
    this.emit('state', 'connecting' satisfies ConnState);
    this.connectedAddress = this.options.addresses[0]!;
    this.emit('state', 'connected' satisfies ConnState);
    return this.welcome;
  }
  async request<T>(type: string, payload?: unknown): Promise<T> {
    if (this.closed) throw new Error('closed');
    this.requests.push({ type, payload });
    return {} as T;
  }
  close(): void {
    this.closed = true;
  }
  /** A reconnect that lands on `address`. */
  reconnect(address: string): void {
    this.connectedAddress = null;
    this.emit('state', 'reconnecting' satisfies ConnState);
    this.connectedAddress = address;
    this.emit('state', 'connected' satisfies ConnState);
    this.emit('welcome', { ...this.welcome, sessionId: `s-${randomBytes(4).toString('hex')}` });
  }
}

interface FakeServer {
  name: string;
  serverKeyId: string;
  address: string;
}

const dir = useTempDir();
let servers: SavedServersStore;
let controller: ClientController;
let conns: FakeConnection[];
let pins: RendererPin[][];
let states: ConnectionStateEvent[];
let events: Array<{ serverId: string; event: Envelope }>;
let A: FakeServer;
let B: FakeServer;
let C: FakeServer;

function server(name: string, host: string): FakeServer {
  return { name, serverKeyId: keyId(), address: `${host}:7700` };
}

function welcomeOf(s: FakeServer): WelcomePayload {
  return {
    self: { userId: userId(), nickname: 'Ana', isOwner: false },
    sessionId: 's-1',
    serverTime: Date.now(),
    server: { name: s.name, version: '0.3.1', joinMode: 'open', serverKeyId: s.serverKeyId },
    features: ['voice'],
    fileToken: 'secret-file-token',
    protocol: { min: 1, max: 1 },
  };
}

beforeEach(() => {
  const identity = IdentityStore.load(dir.path, new FakeSafeStorage());
  identity.create();
  servers = SavedServersStore.load(dir.path);
  conns = [];
  pins = [];
  states = [];
  events = [];
  A = server('Servidor A', 'a.example');
  B = server('Servidor B', 'b.example');
  C = server('Servidor C', 'c.example');
  const known = [A, B, C];
  controller = new ClientController({
    identity,
    settings: SettingsStore.load(dir.path, 'pt-BR'),
    servers,
    setRendererPins: async (set) => {
      pins.push(set);
    },
    emitConnectionState: (e) => states.push(e),
    emitServerEvent: (event, serverId) => events.push({ serverId, event }),
    clientName: 'ghostlink/0.3.1 (test)',
    createConnection: (options) => {
      const s = known.find((k) => k.serverKeyId === options.serverKeyId)!;
      const conn = new FakeConnection(options, welcomeOf(s));
      conns.push(conn);
      return conn;
    },
  });
});

/** Opens a server the first time (an invite) and returns its saved id. */
async function open(s: FakeServer): Promise<string> {
  return (await controller.join({ addresses: [s.address], serverKeyId: s.serverKeyId, nickname: 'Ana' })).serverId;
}

const connOf = (s: FakeServer) => conns.filter((c) => c.options.serverKeyId === s.serverKeyId).at(-1)!;
const pinOf = (s: FakeServer): RendererPin => ({ hostname: s.address.split(':')[0]!, serverKeyId: s.serverKeyId });
const hostsPinned = () => (pins.at(-1) ?? []).map((p) => p.hostname).sort();

describe('without a call (as before)', () => {
  it('one server at a time: another one closes the first, Home closes it, one pin', async () => {
    const a = await open(A);
    expect(pins.at(-1)).toEqual([pinOf(A)]);
    const b = await open(B);
    expect(connOf(A).closed).toBe(true);
    expect(states).toContainEqual({ state: 'idle', serverId: a });
    expect(pins.at(-1)).toEqual([pinOf(B)]);
    await controller.disconnect();
    expect(connOf(B).closed).toBe(true);
    expect(states.at(-1)).toEqual({ state: 'idle', serverId: b });
    expect(pins.at(-1)).toEqual([]);
    expect(controller.currentServerId).toBeNull();
  });
});

describe('a call on A (chamada-continua §1, §2)', () => {
  let a: string;
  beforeEach(async () => {
    a = await open(A);
    await controller.setCall(a);
    states.length = 0;
  });

  it('opening B keeps A connected: two connections, two pins, requests by origin', async () => {
    const b = await open(B);
    expect(connOf(A).closed).toBe(false);
    expect(controller.currentServerId).toBe(b);
    expect(controller.callServerId).toBe(a);
    expect(hostsPinned()).toEqual(['a.example', 'b.example']);
    // A's connection was not closed: no idle for it.
    expect(states.filter((s) => s.serverId === a)).toEqual([]);

    await controller.request('voice.selfState', { muted: true }, a);
    await controller.request('msg.send', { content: 'oi' });
    await controller.request('typing', {}, b);
    expect(connOf(A).requests.map((r) => r.type)).toEqual(['voice.selfState']);
    expect(connOf(B).requests.map((r) => r.type)).toEqual(['msg.send', 'typing']);
    await expect(controller.request('voice.leave', {}, 'not-connected')).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  });

  it('events carry their origin; the call\'s states are marked background', async () => {
    const b = await open(B);
    connOf(A).emit('event', { t: 'voice.state', d: { channelId: 'x', participants: [] } });
    connOf(B).emit('event', { t: 'msg.new', d: {} });
    expect(events).toEqual([
      { serverId: a, event: { t: 'voice.state', d: { channelId: 'x', participants: [] } } },
      { serverId: b, event: { t: 'msg.new', d: {} } },
    ]);
    connOf(A).emit('state', 'reconnecting');
    connOf(B).emit('state', 'reconnecting');
    expect(states.slice(-2)).toEqual([
      { state: 'reconnecting', serverId: a, background: true },
      { state: 'reconnecting', serverId: b },
    ]);
  });

  it('Home keeps the call: A stays, nothing on screen, A\'s pin only', async () => {
    await controller.disconnect();
    expect(connOf(A).closed).toBe(false);
    expect(controller.currentServerId).toBeNull();
    expect(controller.session).toBeNull();
    expect(states).toEqual([]); // the connection did not change: the renderer leaves the screen by itself
    expect(pins.at(-1)).toEqual([pinOf(A)]);
    await expect(controller.request('msg.send', {})).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    await controller.request('voice.leave', {}, a);
    expect(connOf(A).requests.map((r) => r.type)).toEqual(['voice.leave']);
  });

  it('back to A from B or Home: the same connection and its welcome, no reconnect', async () => {
    await open(B);
    const before = conns.length;
    const again = await controller.connectSaved(a);
    expect(conns.length).toBe(before);
    expect(again.serverId).toBe(a);
    expect(again.address).toBe(A.address);
    expect(again).not.toHaveProperty('fileToken');
    expect(connOf(B).closed).toBe(true);
    expect(controller.currentServerId).toBe(a);
    expect(controller.session?.serverId).toBe(a);
    expect(pins.at(-1)).toEqual([pinOf(A)]);

    await controller.disconnect();
    expect(await controller.connectSaved(a)).toMatchObject({ serverId: a });
    expect(conns.length).toBe(before);
  });

  it('hanging up while B is on screen closes A; while A is on screen nothing closes', async () => {
    const b = await open(B);
    await controller.setCall(null);
    expect(connOf(A).closed).toBe(true);
    expect(states.at(-1)).toEqual({ state: 'idle', serverId: a, background: true });
    expect(pins.at(-1)).toEqual([pinOf(B)]);
    expect(controller.currentServerId).toBe(b);

    await controller.setCall(b);
    await controller.setCall(null);
    expect(connOf(B).closed).toBe(false);
    expect(controller.currentServerId).toBe(b);
  });

  it('a call on B ends A\'s: its connection closes', async () => {
    const b = await open(B);
    await controller.setCall(b);
    expect(connOf(A).closed).toBe(true);
    expect(states.at(-1)).toEqual({ state: 'idle', serverId: a, background: true });
    expect(controller.callServerId).toBe(b);
    expect(pins.at(-1)).toEqual([pinOf(B)]);
  });

  it('never more than two: opening C from B closes B, keeps A', async () => {
    await open(B);
    await open(C);
    expect(connOf(B).closed).toBe(true);
    expect(connOf(A).closed).toBe(false);
    expect(hostsPinned()).toEqual(['a.example', 'c.example']);
    for (const set of pins) expect(set.length).toBeLessThanOrEqual(2);
  });

  it('each connection reconnects on its own: A comes back elsewhere, B is untouched', async () => {
    const b = await open(B);
    const session = controller.session;
    connOf(A).reconnect('a2.example:7700');
    expect(states).toContainEqual({ state: 'reconnecting', serverId: a, background: true });
    expect(states.at(-1)).toEqual({ state: 'connected', serverId: a, background: true });
    const welcome = events.find((e) => e.event.t === 'welcome');
    expect(welcome?.serverId).toBe(a);
    expect(welcome?.event.d).toMatchObject({ serverId: a, address: 'a2.example:7700' });
    expect(welcome?.event.d).not.toHaveProperty('fileToken');
    expect(hostsPinned()).toEqual(['a2.example', 'b.example']);
    expect(controller.session).toBe(session); // the screen's session did not change
    expect(controller.currentServerId).toBe(b);
  });

  it('A dropped for good (kicked) while B is on screen: A closes, B stays', async () => {
    const b = await open(B);
    connOf(A).emit('fatal', { code: 'KICKED' });
    expect(connOf(A).closed).toBe(true);
    expect(states.at(-1)).toEqual({ state: 'failed', serverId: a, error: 'KICKED', background: true });
    expect(controller.callServerId).toBeNull();
    expect(controller.currentServerId).toBe(b);
    expect(pins.at(-1)).toEqual([pinOf(B)]);
  });

  it('the server on screen failing leaves the call alone', async () => {
    const b = await open(B);
    connOf(B).emit('fatal', { code: 'BANNED' });
    expect(states.at(-1)).toEqual({ state: 'failed', serverId: b, error: 'BANNED' });
    expect(connOf(A).closed).toBe(false);
    expect(controller.callServerId).toBe(a);
    expect(pins.at(-1)).toEqual([pinOf(A)]);
  });

  it('closing A (Host mode stops it, it leaves the list) ends the call\'s connection', async () => {
    await open(B);
    await controller.closeServer(a);
    expect(connOf(A).closed).toBe(true);
    expect(controller.callServerId).toBeNull();
    expect(connOf(B).closed).toBe(false);
  });

  it('disconnectAll (identity change, quit) closes both', async () => {
    await open(B);
    await controller.disconnectAll();
    expect(connOf(A).closed).toBe(true);
    expect(connOf(B).closed).toBe(true);
    expect(pins.at(-1)).toEqual([]);
  });

  it('the exit dialog uses A\'s session instead of a second login (which would drop the call)', async () => {
    await open(B);
    const before = conns.length;
    expect(await controller.checkExit(a)).toEqual({ kind: 'member' });
    expect(conns.length).toBe(before);
  });
});

describe('setCall', () => {
  it('refuses a server with no connection', async () => {
    await open(A);
    await expect(controller.setCall('nope')).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(controller.callServerId).toBeNull();
  });
});
