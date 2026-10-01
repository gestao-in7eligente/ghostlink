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
  /** Every welcome of the active connection, and null once it is gone or reconnecting (profile photos). */
  onSession?(session: ActiveSession | null): void;
}

/**
 * The live session as main-only features see it (profile photos, spec 2026-10-01 §4).
 * It holds the fileToken: never hand it to the renderer.
 */
export interface ActiveSession {
  serverId: string;
  /** host:port of the current connection. */
  address: string;
  /** The pinned serverKeyId. */
  serverKeyId: string;
  /** The whole welcome: fileToken and module keys (members…) included. */
  welcome: WelcomePayload;
  /** welcome.serverTime minus the local clock when it arrived. */
  clockOffsetMs: number;
  /** A request on this connection only; it fails once the connection is replaced. */
  request<T>(type: string, payload?: unknown): Promise<T>;
}

/** The fileToken never leaves the main process (spec §3.1, §5.3); `address` is the connected host:port. */
export function toRendererWelcome(welcome: WelcomePayload, serverId: string, address: string): RendererWelcome {
  const { fileToken: _fileToken, ...rest } = welcome;
  return { ...rest, serverId, address };
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
  #session: ActiveSession | null = null;

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

  /** The saved-server id of the active connection, or null (Host mode leaves it before a stop). */
  get currentServerId(): string | null {
    return this.#serverId;
  }

  /** The connected session (after a welcome), or null. */
  get session(): ActiveSession | null {
    return this.#session;
  }

  /**
   * Relays a renderer request to the connected server (`server.request` IPC).
   * The IPC layer already allowed only client request types; the server validates
   * the rest. With `serverId`, a request meant for another saved server (the user
   * switched meanwhile) is refused instead of reaching the wrong server.
   */
  request(type: string, payload: unknown, serverId?: string): Promise<unknown> {
    const conn = this.#conn;
    if (!conn) return Promise.reject(new AppError('CONNECTION_LOST', 'not connected'));
    if (serverId !== undefined && serverId !== this.#serverId) return Promise.reject(new AppError('CONNECTION_LOST', 'another server'));
    return conn.request(type, payload ?? {});
  }

  async disconnect(): Promise<void> {
    const conn = this.#conn;
    const serverId = this.#serverId;
    this.#conn = null;
    this.#serverId = null;
    if (!conn) return;
    this.#setSession(null);
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
      if (current() && state === 'reconnecting') this.#setSession(null);
      // 'connected' of the first handshake is announced below, once the server is saved;
      // 'failed' always comes with its error code (catch below, or the 'fatal' handler).
      if (!current() || state === 'failed' || (state === 'connected' && !joined)) return;
      this.#deps.emitConnectionState({ state, serverId: this.#serverId });
    });

    let welcome: WelcomePayload;
    let receivedAt: number;
    try {
      welcome = await conn.connect();
      receivedAt = Date.now();
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
      const at = Date.now();
      if (!current()) return;
      // After a reconnect the new snapshot replaces the renderer's state (spec §13),
      // and the working address may have changed.
      void this.#pin(conn, target.serverKeyId);
      this.#setSession(this.#activeSession(conn, saved.id, target.serverKeyId, again, at, address));
      this.#deps.emitServerEvent({ t: 'welcome', d: toRendererWelcome(again, saved.id, conn.connectedAddress ?? address) });
    });
    conn.on('event', (event: Envelope) => {
      if (current()) this.#deps.emitServerEvent(event);
    });
    conn.on('fatal', ({ code }: { code: AppErrorCode }) => {
      if (current()) this.#fail(conn, code);
    });

    this.#setSession(this.#activeSession(conn, saved.id, target.serverKeyId, welcome, receivedAt, address));
    this.#deps.emitConnectionState({ state: 'connected', serverId: saved.id });
    return toRendererWelcome(welcome, saved.id, address);
  }

  #activeSession(conn: ServerConnection, serverId: string, serverKeyId: string, welcome: WelcomePayload, receivedAt: number, fallbackAddress: string): ActiveSession {
    return {
      serverId,
      address: conn.connectedAddress ?? fallbackAddress,
      serverKeyId,
      welcome,
      clockOffsetMs: welcome.serverTime - receivedAt,
      request: <T>(type: string, payload?: unknown) => conn.request<T>(type, payload ?? {}),
    };
  }

  #setSession(session: ActiveSession | null): void {
    if (session === null && this.#session === null) return;
    this.#session = session;
    this.#deps.onSession?.(session);
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
    this.#setSession(null);
    conn.removeAllListeners();
    conn.close();
    void this.#deps.setRendererPin(null);
    this.#deps.emitConnectionState({ state: 'failed', serverId, error: code });
  }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
