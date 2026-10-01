import {
  FEATURE_SERVER_DELETE,
  ProtocolError,
  formatFingerprint,
  parseHostPort,
  parseJoinInput,
  serverDeleteResultSchemaClient,
  serverDeleteWelcomeSchemaClient,
  serverDeletingEventSchemaClient,
  type Envelope,
  type ParsedJoinInput,
  type ServerDeleteResult,
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
  ServerExitCheck,
} from '../shared/ipcTypes.js';
import { ServerConnection, deletionDeadlineOf, probeServerKeyId, type ServerConnectionOptions } from './connection.js';
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
  /**
   * The owner's deletion of a server, as this app learns it (leave/delete spec §3): `deleting`
   * with the deadline in the LOCAL clock, `restored`, or `deleted` once a server refused with
   * SERVER_DELETED. Only an owner's session reports deleting/restored.
   */
  onDeletion?(update: DeletionUpdate): void;
}

export type DeletionUpdate =
  | { kind: 'deleting'; serverKeyId: string; at: number }
  | { kind: 'restored'; serverKeyId: string }
  | { kind: 'deleted'; serverKeyId: string };

/** What a short connection to a saved server sees (or the active session, when it is that server). */
interface SavedSession {
  serverKeyId: string;
  welcome: WelcomePayload;
  clockOffsetMs: number;
  request<T>(type: string, payload?: unknown): Promise<T>;
}

/** The welcome's `serverDelete.deletingAt` (server clock), null when not being deleted, undefined from an old server. */
function welcomeDeletingAt(welcome: WelcomePayload): number | null | undefined {
  const parsed = serverDeleteWelcomeSchemaClient.safeParse((welcome as unknown as Record<string, unknown>).serverDelete);
  return parsed.success ? parsed.data.deletingAt : undefined;
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
  /** The pinned key of the active connection. */
  #serverKeyId: string | null = null;
  #session: ActiveSession | null = null;
  /** The deadline the active server announced with `server.deleting` (server clock), for its SERVER_DELETING close. */
  #deletingAt: number | null = null;

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
    this.#serverKeyId = null;
    this.#deletingAt = null;
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

  /**
   * "Sair do servidor" on a saved server (leave/delete spec §2, §3): connects to learn whether I
   * am its owner (never by replacing the open session of another server) and answers what the
   * dialog should offer. A server that cannot be reached is not an error: the dialog offers
   * "Tirar só da minha lista". SERVER_DELETED also takes it out of the list.
   */
  async checkExit(id: string): Promise<ServerExitCheck> {
    try {
      return await this.#withSaved(id, async ({ welcome }): Promise<ServerExitCheck> =>
        welcome.self.isOwner
          ? { kind: 'owner', name: welcome.server.name, canDelete: welcome.features.includes(FEATURE_SERVER_DELETE), deletingAt: welcomeDeletingAt(welcome) ?? null }
          : { kind: 'member' },
      );
    } catch (e) {
      const code = toAppErrorCode(e);
      if (code === 'SERVER_DELETING') return { kind: 'deleting', at: deletionDeadlineOf(e) };
      if (code === 'SERVER_DELETED') return { kind: 'deleted' };
      if (code === 'NOT_FOUND' || code === 'IDENTITY_UNAVAILABLE') throw e;
      return { kind: 'unreachable', code };
    }
  }

  /** Leaves a saved server (`server.leave`, optionally with all my messages), then forgets it. The owner cannot. */
  async leaveSaved(id: string, deleteMyMessages: boolean): Promise<void> {
    await this.#withSaved(id, async ({ welcome, request }) => {
      if (welcome.self.isOwner) throw new ProtocolError('OWNER_MUST_TRANSFER');
      await request('server.leave', { deleteMyMessages });
    });
    await this.remove(id);
  }

  /**
   * "Excluir servidor" (leave/delete spec §3): `server.delete`, owner only, on a server with the
   * `serverDelete` feature. The server goes offline for everyone else now and is erased at `at`.
   */
  deleteSaved(id: string): Promise<ServerDeleteResult> {
    return this.#withSaved(id, async ({ serverKeyId, welcome, clockOffsetMs, request }) => {
      if (!welcome.self.isOwner) throw new ProtocolError('FORBIDDEN', 'only the owner deletes the server');
      if (!welcome.features.includes(FEATURE_SERVER_DELETE)) throw new AppError('SERVER_OUTDATED', 'the server cannot delete itself');
      const parsed = serverDeleteResultSchemaClient.safeParse(await request('server.delete', {}));
      if (!parsed.success) throw new ProtocolError('BAD_REQUEST', 'invalid server.delete answer');
      this.#deps.onDeletion?.({ kind: 'deleting', serverKeyId, at: parsed.data.at - clockOffsetMs });
      return { at: parsed.data.at };
    });
  }

  /**
   * The active session when `id` is the open server; otherwise a short connection of its own
   * (no reconnect, closed afterwards), so another server's open session is never replaced.
   */
  async #withSaved<T>(id: string, work: (session: SavedSession) => Promise<T>): Promise<T> {
    const active = this.#session;
    if (this.#serverId === id && this.#conn !== null) {
      if (active === null) throw new AppError('CONNECTION_LOST', 'the server is reconnecting');
      return work({ serverKeyId: active.serverKeyId, welcome: active.welcome, clockOffsetMs: active.clockOffsetMs, request: active.request });
    }
    const saved = this.#deps.servers.get(id);
    if (!saved) throw new ProtocolError('NOT_FOUND');
    if (this.#deps.identity.status !== 'ready') throw new AppError('IDENTITY_UNAVAILABLE');
    const conn = new ServerConnection({
      addresses: saved.addresses,
      serverKeyId: saved.serverKeyId,
      key: this.#deps.identity.serverKey(saved.serverKeyId),
      hello: { nickname: saved.nickname, locale: this.#deps.settings.get().locale, client: this.#deps.clientName },
      reconnect: false,
      ...this.#deps.connectionOptions,
    });
    try {
      const welcome = await conn.connect();
      const clockOffsetMs = welcome.serverTime - Date.now();
      this.#observeWelcome(saved.serverKeyId, welcome, clockOffsetMs);
      return await work({ serverKeyId: saved.serverKeyId, welcome, clockOffsetMs, request: (type, payload) => conn.request(type, payload ?? {}) });
    } catch (e) {
      if (toAppErrorCode(e) === 'SERVER_DELETED') this.#serverDeleted(saved.serverKeyId, saved.id);
      throw e;
    } finally {
      conn.removeAllListeners();
      conn.close();
    }
  }

  /** An owner's welcome tells whether the server is being deleted (a reconnect may follow a restore). */
  #observeWelcome(serverKeyId: string, welcome: WelcomePayload, clockOffsetMs: number): void {
    if (!welcome.self.isOwner) return;
    const at = welcomeDeletingAt(welcome);
    if (at === undefined) return; // a server without the feature
    this.#deps.onDeletion?.(at === null ? { kind: 'restored', serverKeyId } : { kind: 'deleting', serverKeyId, at: at - clockOffsetMs });
  }

  /** The active server's `server.deleting` / `server.restored` (the owner's app records them). */
  #observeEvent(event: Envelope): void {
    if (event.t !== 'server.deleting' && event.t !== 'server.restored') return;
    const session = this.#session;
    const serverKeyId = this.#serverKeyId;
    if (serverKeyId === null) return;
    if (event.t === 'server.restored') {
      this.#deletingAt = null;
      if (session?.welcome.self.isOwner) this.#deps.onDeletion?.({ kind: 'restored', serverKeyId });
      return;
    }
    const parsed = serverDeletingEventSchemaClient.safeParse(event.d);
    if (!parsed.success) return;
    this.#deletingAt = parsed.data.at;
    if (session?.welcome.self.isOwner) this.#deps.onDeletion?.({ kind: 'deleting', serverKeyId, at: parsed.data.at - session.clockOffsetMs });
  }

  /** SERVER_DELETED: the server is gone for good, so it leaves the saved list (leave/delete spec §3). */
  #serverDeleted(serverKeyId: string, savedId: string | null): void {
    const id = savedId ?? this.#deps.servers.findByServerKeyId(serverKeyId)?.id;
    if (id !== undefined) this.#deps.servers.remove(id);
    this.#deps.onDeletion?.({ kind: 'deleted', serverKeyId });
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
    this.#serverKeyId = target.serverKeyId;
    this.#deletingAt = null;
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
      if (current()) this.#fail(conn, toAppErrorCode(e), deletionDeadlineOf(e));
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
      this.#observeWelcome(target.serverKeyId, again, again.serverTime - at);
      this.#deps.emitServerEvent({ t: 'welcome', d: toRendererWelcome(again, saved.id, conn.connectedAddress ?? address) });
    });
    conn.on('event', (event: Envelope) => {
      if (!current()) return;
      this.#observeEvent(event);
      this.#deps.emitServerEvent(event);
    });
    conn.on('fatal', ({ code, at }: { code: AppErrorCode; at?: number }) => {
      if (current()) this.#fail(conn, code, at ?? null);
    });

    this.#setSession(this.#activeSession(conn, saved.id, target.serverKeyId, welcome, receivedAt, address));
    this.#observeWelcome(target.serverKeyId, welcome, welcome.serverTime - receivedAt);
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

  /** `at`: the deletion deadline that came with SERVER_DELETING (else the one `server.deleting` announced). */
  #fail(conn: ServerConnection, code: AppErrorCode, at: number | null = null): void {
    const serverId = this.#serverId;
    const serverKeyId = this.#serverKeyId;
    const deletingAt = at ?? this.#deletingAt;
    this.#conn = null;
    this.#serverId = null;
    this.#serverKeyId = null;
    this.#deletingAt = null;
    this.#setSession(null);
    conn.removeAllListeners();
    conn.close();
    void this.#deps.setRendererPin(null);
    if (code === 'SERVER_DELETED' && serverKeyId !== null) this.#serverDeleted(serverKeyId, serverId);
    const event: ConnectionStateEvent = { state: 'failed', serverId, error: code };
    if (code === 'SERVER_DELETING' && deletingAt !== null) event.deletingAt = deletingAt;
    this.#deps.emitConnectionState(event);
  }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
