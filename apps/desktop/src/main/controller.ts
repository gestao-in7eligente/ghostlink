import {
  ProtocolError,
  formatFingerprint,
  parseHostPort,
  parseJoinInput,
  type Envelope,
  type ParsedJoinInput,
  type WelcomePayload,
} from '@ghostlink/shared';
import { AppError, toAppErrorCode, type AppErrorCode } from '../shared/appErrors.js';
import type {
  ConnState,
  ConnectionStateEvent,
  JoinConnectRequest,
  ProbeResult,
  RendererWelcome,
  SavedServer,
} from '../shared/ipcTypes.js';
import { ServerConnection, probeServerKeyId, type ServerConnectionOptions } from './connection.js';
import type { IdentityStore } from './identity.js';
import type { RendererPin } from './pinning.js';
import type { SavedServersStore } from './savedServers.js';
import type { SettingsStore } from './settings.js';

export interface ControllerDeps {
  identity: Pick<IdentityStore, 'status' | 'serverKey'>;
  settings: Pick<SettingsStore, 'get'>;
  servers: SavedServersStore;
  setRendererPin(pin: RendererPin | null): Promise<void>;
  emitConnectionState(event: ConnectionStateEvent): void;
  emitServerEvent(event: Envelope): void;
  /** `client` field of the hello, e.g. "ghostlink/0.1.0 (win32)". */
  clientName: string;
  /** Tests shorten the timings. */
  connectionOptions?: Pick<ServerConnectionOptions, 'timing' | 'random'>;
}

/** The fileToken never leaves the main process (spec §3.1, §5.3). */
export function toRendererWelcome(welcome: WelcomePayload, serverId: string): RendererWelcome {
  const { fileToken: _fileToken, ...rest } = welcome;
  return { ...rest, serverId };
}

interface Target {
  addresses: string[];
  serverKeyId: string;
  nickname: string;
  credentials: Pick<JoinConnectRequest, 'inviteCode' | 'password' | 'setupCode'>;
  savedId: string | null;
  nameHint: string | undefined;
}

/**
 * The single active server connection (spec §1.3: one server at a time) and
 * everything around it: saved servers, the renderer pin, and the events
 * forwarded to the renderer. The IPC handlers are thin wrappers around this class.
 */
export class ClientController {
  readonly #deps: ControllerDeps;
  #conn: ServerConnection | null = null;
  #serverId: string | null = null;

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
  }

  parse(input: string): ParsedJoinInput {
    return parseJoinInput(input);
  }

  /** TOFU: reads the key of a bare address so the user can compare the fingerprint (spec §3.3). */
  async probe(address: string): Promise<ProbeResult> {
    const serverKeyId = await probeServerKeyId(address);
    return { serverKeyId, fingerprint: formatFingerprint(serverKeyId) };
  }

  /** Joins from an invite, a paste code or a confirmed TOFU address. */
  join(req: JoinConnectRequest): Promise<RendererWelcome> {
    return this.#open({
      addresses: req.addresses,
      serverKeyId: req.serverKeyId,
      nickname: req.nickname,
      credentials: { inviteCode: req.inviteCode, password: req.password, setupCode: req.setupCode },
      savedId: this.#deps.servers.findByServerKeyId(req.serverKeyId)?.id ?? null,
      nameHint: req.name,
    });
  }

  /** Reconnects to a saved server: no credentials, members enter directly (spec §3.3). */
  connectSaved(id: string): Promise<RendererWelcome> {
    const saved = this.#deps.servers.get(id);
    if (!saved) return Promise.reject(new ProtocolError('NOT_FOUND'));
    return this.#open({
      addresses: saved.addresses,
      serverKeyId: saved.serverKeyId,
      nickname: saved.nickname,
      credentials: {},
      savedId: saved.id,
      nameHint: saved.name,
    });
  }

  list(): SavedServer[] {
    return this.#deps.servers.list();
  }

  /**
   * Relays a renderer request to the connected server (`server.request` IPC).
   * The IPC layer already refused the handshake types; the server validates the rest.
   */
  request(type: string, payload: unknown): Promise<unknown> {
    const conn = this.#conn;
    if (!conn) return Promise.reject(new AppError('CONNECTION_LOST', 'not connected'));
    return conn.request(type, payload ?? {});
  }

  async disconnect(): Promise<void> {
    const conn = this.#conn;
    const serverId = this.#serverId;
    this.#conn = null;
    this.#serverId = null;
    if (!conn) return;
    conn.removeAllListeners();
    conn.close();
    await this.#deps.setRendererPin(null);
    this.#deps.emitConnectionState({ state: 'idle', serverId });
  }

  async remove(id: string): Promise<void> {
    if (this.#serverId === id) await this.disconnect();
    this.#deps.servers.remove(id);
  }

  async #open(target: Target): Promise<RendererWelcome> {
    if (this.#deps.identity.status !== 'ready') throw new AppError('IDENTITY_UNAVAILABLE');
    const key = this.#deps.identity.serverKey(target.serverKeyId);
    await this.disconnect();

    const conn = new ServerConnection({
      addresses: target.addresses,
      serverKeyId: target.serverKeyId,
      key,
      hello: {
        nickname: target.nickname,
        locale: this.#deps.settings.get().locale,
        client: this.#deps.clientName,
        ...definedOnly(target.credentials),
      },
      reconnect: true,
      ...this.#deps.connectionOptions,
    });
    this.#conn = conn;
    this.#serverId = target.savedId;
    const current = () => this.#conn === conn;
    let joined = false;

    conn.on('state', (state: ConnState) => {
      // 'connected' of the first handshake is announced below, once the server is saved;
      // 'failed' always comes with its error code (catch below, or the 'fatal' handler).
      if (!current() || state === 'failed' || (state === 'connected' && !joined)) return;
      this.#deps.emitConnectionState({ state, serverId: this.#serverId });
    });

    let welcome: WelcomePayload;
    try {
      welcome = await conn.connect();
    } catch (e) {
      if (current()) this.#fail(conn, toAppErrorCode(e));
      throw e;
    }
    if (!current()) {
      conn.close();
      throw new AppError('CONNECTION_LOST', 'disconnected while joining');
    }

    const address = conn.connectedAddress!;
    const saved = this.#deps.servers.upsert({
      serverKeyId: target.serverKeyId,
      name: welcome.server.name || target.nameHint || address,
      addresses: [address, ...target.addresses],
      nickname: welcome.self.nickname,
    });
    this.#serverId = saved.id;
    joined = true;
    await this.#pin(conn, target.serverKeyId);

    conn.on('welcome', (again: WelcomePayload) => {
      if (!current()) return;
      // After a reconnect the new snapshot replaces the renderer's state (spec §13),
      // and the working address may have changed.
      void this.#pin(conn, target.serverKeyId);
      this.#deps.emitServerEvent({ t: 'welcome', d: toRendererWelcome(again, saved.id) });
    });
    conn.on('event', (event: Envelope) => {
      if (current()) this.#deps.emitServerEvent(event);
    });
    conn.on('fatal', ({ code }: { code: AppErrorCode }) => {
      if (current()) this.#fail(conn, code);
    });

    this.#deps.emitConnectionState({ state: 'connected', serverId: saved.id });
    return toRendererWelcome(welcome, saved.id);
  }

  /**
   * Pins the host this connection currently uses. Chromium's verify proc sees
   * hostnames, not ports, which is why only the connected server is ever pinned (spec §4).
   */
  async #pin(conn: ServerConnection, serverKeyId: string): Promise<void> {
    const address = conn.connectedAddress;
    if (address === null || this.#conn !== conn) return;
    await this.#deps.setRendererPin({ hostname: parseHostPort(address).host, serverKeyId });
  }

  #fail(conn: ServerConnection, code: AppErrorCode): void {
    const serverId = this.#serverId;
    this.#conn = null;
    this.#serverId = null;
    conn.removeAllListeners();
    conn.close();
    void this.#deps.setRendererPin(null);
    this.#deps.emitConnectionState({ state: 'failed', serverId, error: code });
  }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
