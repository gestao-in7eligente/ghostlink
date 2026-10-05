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
  ChannelPrefsPatch,
  ConnState,
  ConnectionStateEvent,
  JoinConnectRequest,
  NotifyMode,
  ProbeResult,
  RendererWelcome,
  SavedServer,
  ServerExitCheck,
} from '../shared/ipcTypes.js';
import { updatedServerIcon, welcomeServerIcon } from './avatars/serverIcon.js';
import { ServerConnection, deletionDeadlineOf, probeServerKeyId, type ServerConnectionOptions } from './connection.js';
import type { IdentityStore } from './identity.js';
import type { RendererPin } from './pinning.js';
import type { SavedServersStore } from './savedServers.js';
import type { SettingsStore } from './settings.js';

export interface ControllerDeps {
  identity: Pick<IdentityStore, 'status' | 'serverKey'>;
  settings: Pick<SettingsStore, 'get'>;
  servers: SavedServersStore;
  /** The renderer pins (pinning.ts): the server on screen and the call's, never more. */
  setRendererPins(pins: RendererPin[]): Promise<void>;
  /** A connection's state; `background` marks the call's while another server (or none) is on screen. */
  emitConnectionState(event: ConnectionStateEvent): void;
  /** A server event and the saved server it came from (chamada-continua §2: the renderer routes by origin). */
  emitServerEvent(event: Envelope, serverId: string): void;
  /** `client` field of the hello, e.g. "ghostlink/0.1.0 (win32)". */
  clientName: string;
  /** Tests shorten the timings. */
  connectionOptions?: Pick<ServerConnectionOptions, 'timing' | 'random'>;
  /** Tests hand in fake connections; a real ServerConnection otherwise. */
  createConnection?(options: ServerConnectionOptions): ConnectionLike;
  /** Every welcome of the connection on screen, and null once it is gone or reconnecting (profile photos). */
  onSession?(session: ActiveSession | null): void;
  /**
   * The owner's deletion of a server, as this app learns it (leave/delete spec §3): `deleting`
   * with the deadline in the LOCAL clock, `restored`, or `deleted` once a server refused with
   * SERVER_DELETED. Only an owner's session reports deleting/restored.
   */
  onDeletion?(update: DeletionUpdate): void;
  /**
   * A server's neutrally named update channel, as a welcome advertises it (the optional `updateChannel` field): a
   * signed update channel a build of this app is served at. The app remembers the most recent one and may switch to
   * that build. Never logged (it carries a member's channel path).
   */
  onServerUpdateChannel?(serverKeyId: string, channel: unknown): void;
}

/** What the controller uses of a ServerConnection (see connection.ts for the events). */
export interface ConnectionLike {
  readonly connectedAddress: string | null;
  connect(): Promise<WelcomePayload>;
  request<T>(type: string, payload?: unknown, timeoutMs?: number): Promise<T>;
  close(): void;
  on(event: 'state' | 'welcome' | 'event' | 'fatal', listener: Parameters<ServerConnection['on']>[1]): unknown;
  removeAllListeners(): unknown;
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

/** One live server connection: the one on screen, the call's, or both at once. */
interface Slot {
  conn: ConnectionLike;
  /** The saved server's id; null until the first welcome of a server not saved yet. */
  serverId: string | null;
  /** The pinned key. */
  serverKeyId: string;
  /** The latest welcome: a return to the call's server hands it back without reconnecting. */
  welcome: WelcomePayload | null;
  /** host:port of the latest welcome (kept while reconnecting). */
  address: string | null;
  /** The renderer pin's host, kept while reconnecting so the call's LiveKit keeps it. */
  pinHost: string | null;
  /** After a welcome; null while reconnecting. */
  session: ActiveSession | null;
  /** The deadline this server announced with `server.deleting` (server clock), for its SERVER_DELETING close. */
  deletingAt: number | null;
}

/** Requests that wait on a remote service, with their own deadline in ms. */
export const LONG_REQUEST_MS: Readonly<Record<string, number>> = {
};

/**
 * The server connections (spec §1.3 as changed by chamada-continua §2): the one on screen
 * and, during a voice call on another server (or on the Home screen), the call's. Never
 * more than these two. Switching servers or going Home keeps the call's connection;
 * hanging up closes it unless it is on screen; a call on another server ends the previous
 * one. Each reconnects on its own. Around them: saved servers, the renderer pins, and the
 * events forwarded to the renderer with their origin. The IPC handlers are thin wrappers.
 */
export class ClientController {
  readonly #deps: ControllerDeps;
  /** The server on screen. */
  #view: Slot | null = null;
  /** The voice call's server (chamada-continua §2): the same slot as #view, another one, or none. */
  #call: Slot | null = null;
  /** The view's session as last reported through onSession. */
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

  /** Which of a saved server's messages raise a notification (its menu in the rail); NOT_FOUND for an unknown id. */
  setNotify(id: string, mode: NotifyMode): void {
    if (!this.#deps.servers.get(id)) throw new ProtocolError('NOT_FOUND');
    this.#deps.servers.setNotify(id, mode);
  }

  /** One of a saved server's text channels' choices here (the channel menu); NOT_FOUND for an unknown id. */
  setChannel(id: string, channelId: string, patch: ChannelPrefsPatch): void {
    if (!this.#deps.servers.get(id)) throw new ProtocolError('NOT_FOUND');
    this.#deps.servers.setChannel(id, channelId, patch);
  }

  /** The saved-server id on screen, or null (Host mode leaves it before a stop). */
  get currentServerId(): string | null {
    return this.#view?.serverId ?? null;
  }

  /** The saved-server id of the voice call's connection, or null. */
  get callServerId(): string | null {
    return this.#call?.serverId ?? null;
  }

  /** The connected session on screen (after a welcome), or null. */
  get session(): ActiveSession | null {
    return this.#session;
  }

  /** The connected session of this saved server, on screen or the call's (after a welcome), or null. */
  sessionOf(serverId: string): ActiveSession | null {
    return this.#slotOf(serverId)?.session ?? null;
  }

  /**
   * Relays a renderer request (`server.request` IPC). The IPC layer already allowed only
   * client request types; the server validates the rest. With `serverId` it goes to that
   * server's connection, the one on screen or the call's (voice requests always name the
   * call's, chamada-continua §2); a server with neither is refused, so a request meant for
   * a server the user just left never reaches another one. Without it, the one on screen.
   */
  request(type: string, payload: unknown, serverId?: string): Promise<unknown> {
    const slot = serverId === undefined ? this.#view : this.#slotOf(serverId);
    if (!slot) return Promise.reject(new AppError('CONNECTION_LOST', serverId === undefined ? 'not connected' : 'not connected to that server'));
    return slot.conn.request(type, payload ?? {}, Object.hasOwn(LONG_REQUEST_MS, type) ? LONG_REQUEST_MS[type] : undefined);
  }

  /**
   * The renderer's voice call (chamada-continua §2): `serverId` is the server it runs on (the
   * one on screen, or the call's already), null once it ended. A call on another server ends
   * the previous one: that connection closes unless it is on screen; so does hanging up.
   */
  async setCall(serverId: string | null): Promise<void> {
    const next = serverId === null ? null : this.#slotOf(serverId);
    if (serverId !== null && next === null) throw new AppError('CONNECTION_LOST', 'not connected to that server');
    const previous = this.#call;
    this.#call = next;
    if (previous !== null && previous !== next && previous !== this.#view) this.#close(previous);
    await this.#syncPins();
  }

  /** Leaves the server on screen (the Home screen); a call there goes on in the background (chamada-continua §1). */
  async disconnect(): Promise<void> {
    this.#leaveView();
    await this.#syncPins();
  }

  /** Closes every connection, the call's too (an identity change, quitting). */
  async disconnectAll(): Promise<void> {
    this.#leaveView();
    const call = this.#call;
    this.#call = null;
    if (call !== null) this.#close(call);
    await this.#syncPins();
  }

  /** Closes this saved server's connection, on screen or the call's (Host mode stops it, it leaves the list). */
  async closeServer(id: string): Promise<void> {
    if (this.#view?.serverId === id) {
      if (this.#call === this.#view) this.#call = null;
      this.#leaveView();
    }
    const call = this.#call;
    if (call?.serverId === id) {
      this.#call = null;
      this.#close(call);
    }
    await this.#syncPins();
  }

  async remove(id: string): Promise<void> {
    await this.closeServer(id);
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
   * The session of `id` when it is connected (on screen or the call's); otherwise a short
   * connection of its own (no reconnect, closed afterwards), so an open session is never
   * replaced (one login per identity: a second one would drop it).
   */
  async #withSaved<T>(id: string, work: (session: SavedSession) => Promise<T>): Promise<T> {
    const slot = this.#slotOf(id);
    if (slot !== null) {
      const active = slot.session;
      if (active === null) throw new AppError('CONNECTION_LOST', 'the server is reconnecting');
      return work({ serverKeyId: active.serverKeyId, welcome: active.welcome, clockOffsetMs: active.clockOffsetMs, request: active.request });
    }
    const saved = this.#deps.servers.get(id);
    if (!saved) throw new ProtocolError('NOT_FOUND');
    if (this.#deps.identity.status !== 'ready') throw new AppError('IDENTITY_UNAVAILABLE');
    const conn = this.#connection({
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
      this.#noteIcon(saved.id, welcomeServerIcon(welcome));
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
    this.#noteUpdateChannel(serverKeyId, (welcome as unknown as Record<string, unknown>).updateChannel);
    if (!welcome.self.isOwner) return;
    const at = welcomeDeletingAt(welcome);
    if (at === undefined) return; // a server without the feature
    this.#deps.onDeletion?.(at === null ? { kind: 'restored', serverKeyId } : { kind: 'deleting', serverKeyId, at: at - clockOffsetMs });
  }

  /**
   * A connected server's `server.updated` (its icon goes into the saved list before the
   * renderer hears of it) and `server.deleting` / `server.restored` (the owner's app records them).
   */
  #observeEvent(slot: Slot, event: Envelope): void {
    const icon = updatedServerIcon(event);
    if (icon !== undefined && slot.serverId !== null) this.#noteIcon(slot.serverId, icon);
    if (event.t !== 'server.deleting' && event.t !== 'server.restored') return;
    const { session, serverKeyId } = slot;
    if (event.t === 'server.restored') {
      slot.deletingAt = null;
      if (session?.welcome.self.isOwner) this.#deps.onDeletion?.({ kind: 'restored', serverKeyId });
      return;
    }
    const parsed = serverDeletingEventSchemaClient.safeParse(event.d);
    if (!parsed.success) return;
    slot.deletingAt = parsed.data.at;
    if (session?.welcome.self.isOwner) this.#deps.onDeletion?.({ kind: 'deleting', serverKeyId, at: parsed.data.at - session.clockOffsetMs });
  }

  /**
   * Hands a server's advertised update channel to onServerUpdateChannel (none from a server that advertises none);
   * a failure there never breaks the connection. Neutral and part of the open source.
   */
  #noteUpdateChannel(serverKeyId: string, channel: unknown): void {
    if (channel === undefined) return;
    try {
      this.#deps.onServerUpdateChannel?.(serverKeyId, channel);
    } catch {
      // a failed write: the next welcome brings the channel again
    }
  }

  /** The saved server's icon (spec 2026-10-01-icone-do-servidor). Cosmetic: a failed write waits for the next welcome. */
  #noteIcon(serverId: string, icon: string | null): void {
    try {
      this.#deps.servers.setIcon(serverId, icon);
    } catch {
      // the rail keeps the previous icon (or the initials) meanwhile
    }
  }

  /** SERVER_DELETED: the server is gone for good, so it leaves the saved list (leave/delete spec §3). */
  #serverDeleted(serverKeyId: string, savedId: string | null): void {
    const id = savedId ?? this.#deps.servers.findByServerKeyId(serverKeyId)?.id;
    if (id !== undefined) this.#deps.servers.remove(id);
    this.#deps.onDeletion?.({ kind: 'deleted', serverKeyId });
  }

  async #open(target: Target): Promise<RendererWelcome> {
    if (this.#deps.identity.status !== 'ready') throw new AppError('IDENTITY_UNAVAILABLE');
    // Back to the call's server: at once, on the connection the call already uses (chamada-continua §1).
    const call = this.#call;
    if (call !== null && call.serverKeyId === target.serverKeyId && call.serverId !== null && call.welcome !== null) {
      if (this.#view !== call) {
        this.#leaveView();
        this.#view = call;
        this.#setSession(call.session);
      }
      await this.#syncPins();
      return toRendererWelcome(call.welcome, call.serverId, call.address ?? '');
    }
    const key = this.#deps.identity.serverKey(target.serverKeyId);
    this.#leaveView();
    await this.#syncPins();

    const conn = this.#connection({
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
    const slot: Slot = {
      conn,
      serverId: target.savedId,
      serverKeyId: target.serverKeyId,
      welcome: null,
      address: null,
      pinHost: null,
      session: null,
      deletingAt: null,
    };
    this.#view = slot;
    const current = () => this.#owns(slot);
    let joined = false;

    conn.on('state', (state: ConnState) => {
      if (!current()) return;
      if (state === 'reconnecting') this.#setSlotSession(slot, null);
      // 'connected' of the first handshake is announced below, once the server is saved;
      // 'failed' always comes with its error code (catch below, or the 'fatal' handler).
      if (state === 'failed' || (state === 'connected' && !joined)) return;
      this.#emitState(slot, state);
    });

    let welcome: WelcomePayload;
    let receivedAt: number;
    try {
      welcome = await conn.connect();
      receivedAt = Date.now();
    } catch (e) {
      if (current()) this.#fail(slot, toAppErrorCode(e), deletionDeadlineOf(e));
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
    slot.serverId = saved.id;
    this.#noteIcon(saved.id, welcomeServerIcon(welcome));
    joined = true;
    this.#noteWelcome(slot, welcome, address);
    await this.#syncPins();

    conn.on('welcome', (again: WelcomePayload) => {
      const at = Date.now();
      if (!current()) return;
      // After a reconnect the new snapshot replaces the renderer's state (spec §13),
      // and the working address may have changed.
      const now = conn.connectedAddress ?? address;
      this.#noteWelcome(slot, again, now);
      this.#noteIcon(saved.id, welcomeServerIcon(again));
      void this.#syncPins();
      this.#setSlotSession(slot, this.#activeSession(conn, saved.id, target.serverKeyId, again, at, now));
      this.#observeWelcome(target.serverKeyId, again, again.serverTime - at);
      this.#deps.emitServerEvent({ t: 'welcome', d: toRendererWelcome(again, saved.id, now) }, saved.id);
    });
    conn.on('event', (event: Envelope) => {
      if (!current()) return;
      this.#observeEvent(slot, event);
      this.#deps.emitServerEvent(event, saved.id);
    });
    conn.on('fatal', ({ code, at }: { code: AppErrorCode; at?: number }) => {
      if (current()) this.#fail(slot, code, at ?? null);
    });

    this.#setSlotSession(slot, this.#activeSession(conn, saved.id, target.serverKeyId, welcome, receivedAt, address));
    this.#observeWelcome(target.serverKeyId, welcome, welcome.serverTime - receivedAt);
    this.#emitState(slot, 'connected');
    return toRendererWelcome(welcome, saved.id, address);
  }

  #connection(options: ServerConnectionOptions): ConnectionLike {
    return this.#deps.createConnection?.(options) ?? new ServerConnection(options);
  }

  #activeSession(conn: ConnectionLike, serverId: string, serverKeyId: string, welcome: WelcomePayload, receivedAt: number, fallbackAddress: string): ActiveSession {
    return {
      serverId,
      address: conn.connectedAddress ?? fallbackAddress,
      serverKeyId,
      welcome,
      clockOffsetMs: welcome.serverTime - receivedAt,
      request: <T>(type: string, payload?: unknown) => conn.request<T>(type, payload ?? {}),
    };
  }

  /** A connection still in use: on screen or the call's. */
  #owns(slot: Slot): boolean {
    return slot === this.#view || slot === this.#call;
  }

  /** The connection to this saved server, on screen or the call's. */
  #slotOf(serverId: string): Slot | null {
    if (this.#view?.serverId === serverId) return this.#view;
    if (this.#call?.serverId === serverId) return this.#call;
    return null;
  }

  #noteWelcome(slot: Slot, welcome: WelcomePayload, address: string): void {
    slot.welcome = welcome;
    slot.address = address;
    slot.pinHost = parseHostPort(address).host;
  }

  /** A connection's session; the one on screen is what main-only features see (onSession). */
  #setSlotSession(slot: Slot, session: ActiveSession | null): void {
    slot.session = session;
    if (slot === this.#view) this.#setSession(session);
  }

  #setSession(session: ActiveSession | null): void {
    if (session === null && this.#session === null) return;
    this.#session = session;
    this.#deps.onSession?.(session);
  }

  /** Nothing on screen any more; that connection closes unless the call uses it. */
  #leaveView(): void {
    const view = this.#view;
    if (view === null) return;
    this.#view = null;
    this.#setSession(null);
    if (view !== this.#call) this.#close(view, true);
  }

  /** Closes a connection already taken out of #view/#call; `wasView`: the renderer knew it as the one on screen. */
  #close(slot: Slot, wasView = false): void {
    slot.conn.removeAllListeners();
    slot.conn.close();
    this.#deps.emitConnectionState(wasView ? { state: 'idle', serverId: slot.serverId } : { state: 'idle', serverId: slot.serverId, background: true });
  }

  /** A state of this connection; marked `background` when it is the call's and another server (or none) is on screen. */
  #emitState(slot: Slot, state: ConnState): void {
    this.#deps.emitConnectionState(slot === this.#view ? { state, serverId: slot.serverId } : { state, serverId: slot.serverId, background: true });
  }

  /**
   * The renderer pins: the hosts these connections currently use, so at most the one on
   * screen and the call's. Chromium's verify proc sees hostnames, not ports, which is why
   * nothing else is ever pinned (spec §4).
   */
  async #syncPins(): Promise<void> {
    const pins: RendererPin[] = [];
    for (const slot of new Set([this.#view, this.#call])) {
      if (slot?.pinHost) pins.push({ hostname: slot.pinHost, serverKeyId: slot.serverKeyId });
    }
    await this.#deps.setRendererPins(pins);
  }

  /** `at`: the deletion deadline that came with SERVER_DELETING (else the one `server.deleting` announced). */
  #fail(slot: Slot, code: AppErrorCode, at: number | null = null): void {
    const deletingAt = at ?? slot.deletingAt;
    const wasView = slot === this.#view;
    if (wasView) {
      this.#view = null;
      this.#setSession(null);
    }
    if (slot === this.#call) this.#call = null;
    slot.conn.removeAllListeners();
    slot.conn.close();
    void this.#syncPins();
    if (code === 'SERVER_DELETED') this.#serverDeleted(slot.serverKeyId, slot.serverId);
    const event: ConnectionStateEvent = { state: 'failed', serverId: slot.serverId, error: code };
    if (code === 'SERVER_DELETING' && deletingAt !== null) event.deletingAt = deletingAt;
    if (!wasView) event.background = true;
    this.#deps.emitConnectionState(event);
  }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
