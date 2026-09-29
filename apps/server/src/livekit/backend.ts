import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { RoomServiceClient } from 'livekit-server-sdk';
import type { Logger } from '../logger.js';
import { fallbackNodeIp } from '../net/addresses.js';
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
 * start() itself rejected. A crash of a running LiveKit, and a restart(), call onDown(),
 * then again onReady() or onUnavailable(). `available` is already up to date in every callback.
 */
export interface VoiceBackendListeners {
  /** LiveKit (re)started: rebuild the voice map (spec §7). */
  onReady(): void;
  onWebhook(event: VoiceWebhookEvent): void;
  /** LiveKit stopped (a crash, or a restart with a new config) and is being restarted: voice is down meanwhile. */
  onDown(): void;
  /** LiveKit gave up restarting: voice is unavailable. */
  onUnavailable(): void;
}

/** What goes into LiveKit's config at a (re)start. */
export interface VoiceBackendStartOptions {
  /** rtc.node_ip: the IP LiveKit announces to clients (spec §8.1), chosen by the voice module. */
  nodeIp: string;
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
  start(listeners: VoiceBackendListeners, options: VoiceBackendStartOptions): Promise<void>;
  /**
   * Stops LiveKit and starts it again with a new config (a new node_ip): onDown(), then
   * onReady() or onUnavailable() as after a crash. Everyone connected is dropped, so the
   * voice module only calls it while nobody is in voice. Resolves once LiveKit answers
   * again; rejects when that attempt failed (the supervisor keeps retrying).
   */
  restart(options: VoiceBackendStartOptions): Promise<void>;
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
  /**
   * Explicit IP announced to clients (CLI --node-ip, spec §8.1). It wins over the `net`
   * module's choice (UPnP WAN IP, else a local address) and over the address fallback.
   */
  nodeIp?: string;
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
  readonly #opts: Required<Omit<VoiceServerOptions, 'binaryPath' | 'nodeIp'>> & { binaryPath: string; dataDir: string; logger: Logger };
  /** rtc.node_ip for the next (re)start; each start writes it into livekit.yaml. */
  #nodeIp: string;
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
    };
    this.#nodeIp = opts.nodeIp ?? fallbackNodeIp().ip;
  }

  /** The node_ip LiveKit announces (or will, at its next start). */
  get nodeIp(): string {
    return this.#nodeIp;
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

  /** `options.nodeIp` overrides the constructor's (the voice module always passes one). */
  start(listeners: VoiceBackendListeners, options?: Partial<VoiceBackendStartOptions>): Promise<void> {
    this.#stopped = false;
    this.#listeners = listeners;
    if (options?.nodeIp) this.#nodeIp = options.nodeIp;
    this.#starting = this.#start();
    return this.#starting;
  }

  restart(options: VoiceBackendStartOptions): Promise<void> {
    this.#nodeIp = options.nodeIp;
    if (this.#stopped || !this.#listeners) return Promise.resolve(); // not started: start() uses it
    const previous = this.#starting;
    const run = async (): Promise<void> => {
      await previous?.catch(() => {});
      const supervised = this.#process;
      if (this.#stopped || !supervised) return;
      await supervised.stop();
      if (this.#stopped) return;
      this.#listeners?.onDown();
      // Its prepare() writes livekit.yaml again, with the new node_ip.
      await supervised.start();
    };
    this.#starting = run();
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
          nodeIp: this.#nodeIp,
          ...this.keys,
          webhookUrl,
        });
        return { configPath, port };
      },
      onReady: (port) => {
        this.#rooms = new RoomServiceClient(`http://127.0.0.1:${port}`, this.keys.apiKey, this.keys.apiSecret, { requestTimeout: 10 });
        this.#listeners?.onReady();
      },
      onCrash: () => this.#listeners?.onDown(),
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
