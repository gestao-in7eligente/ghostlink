import { createSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { DEFAULT_EVERYONE_PERMISSIONS } from '@ghostlink/shared';
import type { LivekitParticipant, VoiceBackend, VoiceBackendListeners, VoiceBackendStartOptions, VoiceWebhookEvent } from '../../src/livekit/backend.js';
import type { LivekitPermission } from '../../src/livekit/permissions.js';
import type { ModuleContext } from '../../src/modules.js';
import type { NodeIpChoice } from '../../src/net/addresses.js';
import type { NetModule, NetStatus } from '../../src/net/netModule.js';
import type { MembershipRemovedReason, TextModuleVoiceSeams, VoiceAccess } from '../../src/voice/access.js';

export const FAKE_KEYS = { apiKey: 'GLfakeApiKey', apiSecret: 's'.repeat(43) };

function udpBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    socket.once('error', () => resolve(false));
    socket.bind(port, '0.0.0.0', () => socket.close(() => resolve(true)));
  });
}

function tcpBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createTcpServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
}

/**
 * Public media ports for a real livekit-server in tests. LiveKit binds the UDP port on
 * every interface, so a port borrowed from the TCP ephemeral range is not enough: on
 * Windows it may sit in an excluded UDP range (bind fails with an access error). These
 * come from below the dynamic range and were just bound on all interfaces.
 */
export async function freeMediaPorts(): Promise<{ udpPort: number; tcpPort: number }> {
  const pick = async (bindable: (port: number) => Promise<boolean>, not?: number): Promise<number> => {
    for (let i = 0; i < 200; i++) {
      const port = 20_000 + Math.floor(Math.random() * 25_000);
      if (port !== not && (await bindable(port))) return port;
    }
    throw new Error('no free media port');
  };
  const udpPort = await pick(udpBindable);
  return { udpPort, tcpPort: await pick(tcpBindable, udpPort) };
}

export type BackendCall =
  | { op: 'remove'; room: string; identity: string }
  | { op: 'update'; room: string; identity: string; permission: LivekitPermission };

/** What the fake LiveKit signaling server saw (the /rtc proxy must forward it unchanged). */
export interface SeenRequest {
  method: string;
  url: string;
  upgrade: boolean;
  headers: IncomingMessage['headers'];
}

/**
 * In-memory LiveKit: records RoomService calls, lets tests emit webhooks and keeps a
 * participant list for listRooms/listParticipants. Its "signaling port" is a real
 * loopback HTTP + WebSocket server, so the /rtc proxy can be tested end to end.
 */
export class FakeBackend implements VoiceBackend {
  readonly keys = FAKE_KEYS;
  available = true;
  readonly calls: BackendCall[] = [];
  readonly seen: SeenRequest[] = [];
  readonly rooms = new Map<string, Map<string, LivekitParticipant>>();
  /**
   * Answer upgrades like LiveKit refusing a join (400) and keep the connection open, as
   * Go's HTTP server does; whatever arrives on it afterwards lands in `afterRefusal`.
   */
  refuseUpgrades = false;
  readonly afterRefusal: Buffer[] = [];
  /** false: start() leaves LiveKit booting (unavailable, no onReady) until up(). */
  readyOnStart = true;
  /** The node_ip of the first start and of every restart, in order. */
  readonly nodeIps: string[] = [];
  listeners: VoiceBackendListeners | null = null;
  #server: Server | null = null;
  #wss: WebSocketServer | null = null;
  #port: number | null = null;

  get signalPort(): number | null {
    return this.available ? this.#port : null;
  }

  async start(listeners: VoiceBackendListeners, options: VoiceBackendStartOptions): Promise<void> {
    this.listeners = listeners;
    this.nodeIps.push(options.nodeIp);
    const wss = new WebSocketServer({ noServer: true });
    this.#wss = wss;
    const server = createServer((req, res) => {
      this.seen.push({ method: req.method ?? '', url: req.url ?? '', upgrade: false, headers: req.headers });
      const body = `livekit saw ${req.url}`;
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Fake-Livekit': 'yes', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    });
    server.on('upgrade', (req, socket, head) => {
      this.seen.push({ method: req.method ?? '', url: req.url ?? '', upgrade: true, headers: req.headers });
      if (this.refuseUpgrades) {
        if (head.length > 0) this.afterRefusal.push(head);
        socket.on('data', (chunk: Buffer) => this.afterRefusal.push(chunk));
        socket.on('end', () => socket.end()); // Go closes a kept-alive connection at EOF
        socket.write('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nContent-Length: 3\r\n\r\nbad');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(`hello from livekit ${req.url}`);
        ws.on('message', (data) => ws.send(`echo ${String(data)}`));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
    if (this.readyOnStart) listeners.onReady();
  }

  /** A restart with a new config, as LivekitBackend does it: down (onDown), then up again shortly after. */
  async restart(options: VoiceBackendStartOptions): Promise<void> {
    this.nodeIps.push(options.nodeIp);
    this.crash();
    await new Promise((r) => setTimeout(r, 20));
    if (this.listeners) this.up();
  }

  /** LiveKit answers (first start, or a restart after a crash). */
  up(): void {
    this.available = true;
    this.listeners?.onReady();
  }

  /** LiveKit died; the supervisor is restarting it. */
  crash(): void {
    this.available = false;
    this.listeners?.onDown();
  }

  /** The supervisor gave up restarting LiveKit. */
  giveUp(): void {
    this.available = false;
    this.listeners?.onUnavailable();
  }

  async stop(): Promise<void> {
    this.listeners = null;
    for (const client of this.#wss?.clients ?? []) client.terminate();
    this.#wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
    this.#server = null;
  }

  async listRooms(): Promise<string[]> {
    return [...this.rooms.keys()];
  }

  async listParticipants(room: string): Promise<LivekitParticipant[]> {
    return [...(this.rooms.get(room)?.values() ?? [])];
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    this.calls.push({ op: 'remove', room, identity });
    const r = this.rooms.get(room);
    const p = r?.get(identity);
    if (!r || !p) return;
    r.delete(identity);
    if (r.size === 0) this.rooms.delete(room);
    this.emit({ event: 'participant_left', room, identity, participantSid: p.sid, track: null });
  }

  async updatePermission(room: string, identity: string, permission: LivekitPermission): Promise<void> {
    this.calls.push({ op: 'update', room, identity, permission });
  }

  emit(event: VoiceWebhookEvent): void {
    this.listeners?.onWebhook(event);
  }

  /** A participant becomes active in LiveKit (participant_joined webhook). */
  join(room: string, identity: string, sid = `PA_${identity}_${Math.random().toString(36).slice(2, 8)}`): string {
    const r = this.rooms.get(room) ?? new Map<string, LivekitParticipant>();
    r.set(identity, { identity, sid, tracks: [] });
    this.rooms.set(room, r);
    this.emit({ event: 'participant_joined', room, identity, participantSid: sid, track: null });
    return sid;
  }

  /** Puts a participant in LiveKit's list without a webhook (as if the webhook was lost). */
  seed(room: string, identity: string, sid = `PA_seed_${identity}`): void {
    const r = this.rooms.get(room) ?? new Map<string, LivekitParticipant>();
    r.set(identity, { identity, sid, tracks: [{ sid: `TR_${sid}`, source: 'microphone' }] });
    this.rooms.set(room, r);
  }

  removals(): string[] {
    return this.calls.filter((c) => c.op === 'remove').map((c) => `${c.room}/${c.identity}`);
  }

  updates(identity: string): LivekitPermission[] {
    return this.calls.filter((c): c is Extract<BackendCall, { op: 'update' }> => c.op === 'update' && c.identity === identity).map((c) => c.permission);
  }
}

/**
 * A `net` module (spec §8.1) whose node IP and first UPnP answer the test controls:
 * ready() stays pending until answer() when it starts unanswered.
 */
export class StubNet implements NetModule {
  readonly name = 'net';
  choice: NodeIpChoice | null;
  readonly #ready: Promise<void>;
  #settle!: () => void;

  constructor(choice: NodeIpChoice | null, o: { answered?: boolean } = {}) {
    this.choice = choice;
    this.#ready = new Promise<void>((resolve) => (this.#settle = resolve));
    if (o.answered !== false) this.#settle();
  }

  /** The first UPnP attempt settled (with the router's WAN IP, say). */
  answer(choice: NodeIpChoice | null): void {
    this.choice = choice;
    this.#settle();
  }

  nodeIp(): string | null {
    return this.choice?.ip ?? null;
  }

  nodeIpChoice(): NodeIpChoice | null {
    return this.choice ? { ...this.choice } : null;
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  status(): NetStatus {
    return { upnp: { state: 'off', wanIp: null, mappings: [] }, cgnat: false, nodeIp: this.nodeIp(), localAddresses: [] };
  }

  async refresh(): Promise<NetStatus> {
    return this.status();
  }
}

export interface StubChannel {
  type: 'text' | 'voice';
  userLimit: number;
}

/**
 * A `text` module that only implements the voice seams: channels, per-user bits per
 * channel (0 = cannot see), owner and role positions, plus the two hooks.
 */
export class StubText implements TextModuleVoiceSeams {
  readonly name = 'text';
  readonly channels = new Map<string, StubChannel>();
  /** `${userId}:${channelId}` → bits; missing → `defaultBits` for public channels. */
  readonly bits = new Map<string, number>();
  /** Channels only listed users may see (bits 0 for everyone else). */
  readonly privateChannels = new Set<string>();
  readonly positions = new Map<string, number>();
  defaultBits = DEFAULT_EVERYONE_PERMISSIONS;
  owner: string | null = null;
  #ctx: ModuleContext | null = null;
  #removed = new Set<(userId: string, reason: MembershipRemovedReason) => void>();
  #changed = new Set<() => void>();

  readonly voiceAccess: VoiceAccess = {
    channel: (id) => this.channels.get(id) ?? null,
    permissions: (userId, channelId) => {
      if (!this.channels.has(channelId)) return 0;
      const explicit = this.bits.get(`${userId}:${channelId}`);
      if (explicit !== undefined) return explicit;
      return this.privateChannels.has(channelId) ? 0 : this.defaultBits;
    },
    isOwner: (userId) => userId === this.owner,
    topPosition: (userId) => this.positions.get(userId) ?? 0,
  };

  init(ctx: ModuleContext): void {
    this.#ctx = ctx;
  }

  /** What Text's member.kick does: end the session at once, then announce the removal. */
  kick(userId: string): void {
    this.#ctx!.sessions.closeUser(userId, 'KICKED');
    this.emitRemoved(userId, 'kicked');
  }

  onMembershipRemoved(listener: (userId: string, reason: MembershipRemovedReason) => void): () => void {
    this.#removed.add(listener);
    return () => this.#removed.delete(listener);
  }

  onPermissionsChanged(listener: () => void): () => void {
    this.#changed.add(listener);
    return () => this.#changed.delete(listener);
  }

  setBits(userId: string, channelId: string, bits: number): void {
    this.bits.set(`${userId}:${channelId}`, bits);
  }

  emitRemoved(userId: string, reason: MembershipRemovedReason): void {
    for (const l of this.#removed) l(userId, reason);
  }

  emitChanged(): void {
    for (const l of this.#changed) l();
  }
}

/**
 * The Text track's own signal style: `events.on(name, listener)` returning an unsubscribe,
 * with `membership.removed`, `access.changed`, `channel.deleted` and `visibility.changed`.
 * Only the events seam here (no onMembershipRemoved / onPermissionsChanged hooks).
 */
export class EventsText implements TextModuleVoiceSeams {
  readonly name = 'text';
  readonly stub = new StubText();
  readonly voiceAccess: VoiceAccess = this.stub.voiceAccess;
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly events = {
    on: (event: string, listener: (payload: never) => void): (() => void) => {
      const set = this.#listeners.get(event) ?? new Set<(payload: unknown) => void>();
      this.#listeners.set(event, set);
      set.add(listener as (payload: unknown) => void);
      return () => void set.delete(listener as (payload: unknown) => void);
    },
  };

  init(ctx: ModuleContext): void {
    this.stub.init(ctx);
  }

  emit(event: string, payload: unknown): void {
    for (const l of this.#listeners.get(event) ?? []) l(payload);
  }

  listenerCount(): number {
    return [...this.#listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}
