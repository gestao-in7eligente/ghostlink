import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { RoomServiceClient } from 'livekit-server-sdk';
import type { Logger } from '../logger.js';
import { loadOrCreateLivekitKeys, writeLivekitConfig, type LivekitKeys } from './config.js';
import type { LivekitPermission } from './permissions.js';
import { LivekitProcess, type LivekitState } from './process.js';
import { WebhookServer, trackKind, type TrackKind, type VoiceWebhookEvent } from './webhooks.js';

export type { TrackKind, VoiceWebhookEvent } from './webhooks.js';

/** A participant as LiveKit's RoomService reports it. */
export interface LivekitParticipant {
  identity: string;
  sid: string;
  tracks: { sid: string; source: TrackKind }[];
}

/**
 * Contract: after start(), unless stop() comes first, the backend eventually calls
 * onReady() or, when it gives up (no more restarts), onUnavailable() — also when
 * start() itself rejected.
 */
export interface VoiceBackendListeners {
  /** LiveKit (re)started: rebuild the voice map (spec §7). */
  onReady(): void;
  onWebhook(event: VoiceWebhookEvent): void;
  /** LiveKit gave up restarting: voice is unavailable. */
  onUnavailable(): void;
}

/**
 * Everything the voice module needs from LiveKit. The real one runs livekit-server;
 * tests plug in a fake. Room and identity arguments are LiveKit names (ch_…, u_…).
 */
export interface VoiceBackend {
  readonly available: boolean;
  readonly keys: LivekitKeys;
  /** 127.0.0.1 signaling port for the /rtc proxy while available. */
  readonly signalPort: number | null;
  start(listeners: VoiceBackendListeners): Promise<void>;
  stop(): Promise<void>;
  listRooms(): Promise<string[]>;
  listParticipants(room: string): Promise<LivekitParticipant[]>;
  /** Ignores "participant not found". */
  removeParticipant(room: string, identity: string): Promise<void>;
  /** Always the complete block (spec §6). Ignores "participant not found". */
  updatePermission(room: string, identity: string, permission: LivekitPermission): Promise<void>;
}

/** Options that reach the voice module from StartServerOptions.voice. */
export interface VoiceServerOptions {
  /** livekit-server executable; default: see livekit/binary.ts. */
  binaryPath?: string;
  /** Public UDP media port (spec §8.5). Default 7882. */
  udpPort?: number;
  /** Public ICE-TCP port. Default 7881. */
  tcpPort?: number;
  /** IP announced to clients (spec §8.1): explicit > UPnP WAN (Hosting) > first private LAN IPv4 > 127.0.0.1. */
  nodeIp?: string;
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** The first private (RFC 1918) LAN IPv4 of this machine, else 127.0.0.1. */
export function defaultNodeIp(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string {
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && PRIVATE_V4.test(i.address)) return i.address;
    }
  }
  return '127.0.0.1';
}

/** A free TCP port on 127.0.0.1 (LiveKit's internal ports are chosen on every start, spec §8.1). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function isNotFound(e: unknown): boolean {
  const err = e as { status?: unknown; code?: unknown; message?: unknown };
  return err?.status === 404 || err?.code === 'not_found' || /not.?found|does not exist/i.test(String(err?.message ?? ''));
}

/** The real backend: livekit-server under a supervisor, its webhooks and its RoomService API. */
export class LivekitBackend implements VoiceBackend {
  readonly keys: LivekitKeys;
  readonly #opts: Required<Omit<VoiceServerOptions, 'binaryPath'>> & { binaryPath: string; dataDir: string; logger: Logger };
  #process: LivekitProcess | null = null;
  #webhooks: WebhookServer | null = null;
  #rooms: RoomServiceClient | null = null;
  #listeners: VoiceBackendListeners | null = null;
  #stopped = false;
  #starting: Promise<void> | null = null;

  constructor(opts: VoiceServerOptions & { binaryPath: string; dataDir: string; logger: Logger }) {
    this.keys = loadOrCreateLivekitKeys(opts.dataDir);
    this.#opts = {
      binaryPath: opts.binaryPath,
      dataDir: opts.dataDir,
      logger: opts.logger,
      udpPort: opts.udpPort ?? 7882,
      tcpPort: opts.tcpPort ?? 7881,
      nodeIp: opts.nodeIp ?? defaultNodeIp(),
    };
  }

  get available(): boolean {
    return this.#process?.state === 'running';
  }

  get signalPort(): number | null {
    return this.#process?.port ?? null;
  }

  get state(): LivekitState {
    return this.#process?.state ?? 'stopped';
  }

  start(listeners: VoiceBackendListeners): Promise<void> {
    this.#stopped = false;
    this.#listeners = listeners;
    this.#starting = this.#start();
    return this.#starting;
  }

  async #start(): Promise<void> {
    const webhooks = new WebhookServer({ ...this.keys, logger: this.#opts.logger, onEvent: (e) => this.#listeners?.onWebhook(e) });
    this.#webhooks = webhooks;
    let webhookUrl: string;
    try {
      webhookUrl = await webhooks.listen();
    } catch (e) {
      // Nothing to supervise without the receiver: give up now (see VoiceBackendListeners).
      if (!this.#stopped) this.#listeners?.onUnavailable();
      throw e;
    }
    if (this.#stopped) return;
    this.#process = new LivekitProcess({
      binaryPath: this.#opts.binaryPath,
      dataDir: this.#opts.dataDir,
      logger: this.#opts.logger,
      prepare: async () => {
        const port = await freeLoopbackPort();
        const configPath = writeLivekitConfig(this.#opts.dataDir, {
          port,
          udpPort: this.#opts.udpPort,
          tcpPort: this.#opts.tcpPort,
          nodeIp: this.#opts.nodeIp,
          ...this.keys,
          webhookUrl,
        });
        return { configPath, port };
      },
      onReady: (port) => {
        this.#rooms = new RoomServiceClient(`http://127.0.0.1:${port}`, this.keys.apiKey, this.keys.apiSecret, { requestTimeout: 10 });
        this.#listeners?.onReady();
      },
      onGiveUp: () => this.#listeners?.onUnavailable(),
    });
    await this.#process.start();
  }

  /** Stops LiveKit and the webhook receiver, also while a start is still in progress. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#listeners = null;
    await this.#process?.stop();
    await this.#starting?.catch(() => {});
    await this.#process?.stop();
    await this.#webhooks?.close();
    this.#rooms = null;
  }

  #client(): RoomServiceClient {
    if (!this.#rooms || !this.available) throw new Error('LiveKit is not running');
    return this.#rooms;
  }

  async listRooms(): Promise<string[]> {
    return (await this.#client().listRooms()).map((r) => r.name);
  }

  async listParticipants(room: string): Promise<LivekitParticipant[]> {
    try {
      const list = await this.#client().listParticipants(room);
      return list.map((p) => ({ identity: p.identity, sid: p.sid, tracks: p.tracks.map((t) => ({ sid: t.sid, source: trackKind(t.source) })) }));
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    try {
      await this.#client().removeParticipant(room, identity);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async updatePermission(room: string, identity: string, permission: LivekitPermission): Promise<void> {
    try {
      await this.#client().updateParticipant(room, identity, { permission });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
}
