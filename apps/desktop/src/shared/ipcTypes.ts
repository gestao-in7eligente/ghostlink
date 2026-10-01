// The typed contract between the main process, the preload script and the renderer
// (interface contract §5). Type-only imports keep this file free of runtime
// dependencies, so the sandboxed preload bundle stays tiny.
import type { Envelope, ParsedJoinInput, WelcomePayload } from '@ghostlink/shared';
import type { AppErrorCode } from './appErrors.js';
import type { AttachmentsApi, SaveResult, UploadResult } from './attachmentTypes.js';
import type { DrawApi, OverlayStroke } from './drawOverlay.js';
import type { FirewallFixResult, FirewallStatus, HostApi, HostConfig, HostInvite, HostInviteOptions, HostStartResult, HostStatus } from './hostTypes.js';
import type { DmApi, DmConversation, DmMessage } from './dmTypes.js';
import type { FriendsApi, FriendsSnapshot } from './friendsTypes.js';
import type { AvatarInfo, ProfileApi } from './profileTypes.js';
import type { RailwayAccount, RailwayCreateRequest, RailwayPending, RailwayProgress } from './railwayTypes.js';
import type { ScreenApi, ScreenChoice, ScreenSource } from './screenTypes.js';
import type { ManagedServerUpdate, ServerUpdatesApi } from './serverUpdateTypes.js';
import type { ReleaseNotesResult, UpdateState, UpdatesApi } from './updates.js';

export type IdentityStatus = 'none' | 'ready' | 'locked';
export type ConnState = 'idle' | 'connecting' | 'authenticating' | 'connected' | 'reconnecting' | 'failed';
export type Locale = 'pt-BR' | 'en';

/** Same values as NodeJS.Platform, which the renderer's typecheck (no Node types) cannot see. */
export type Platform = 'aix' | 'android' | 'cygwin' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'netbsd' | 'openbsd' | 'sunos' | 'win32';

export interface AppInfo {
  version: string;
  platform: Platform;
  locale: string;
}

export interface Settings {
  locale: Locale;
  nickname: string;
}

export interface SavedServer {
  id: string;
  name: string;
  addresses: string[];
  serverKeyId: string;
  nickname: string;
  addedAt: number;
}

/**
 * The welcome as the renderer sees it: never the fileToken (spec §3.1), plus the saved
 * server's id and `address`, the "host:port" main is connected to — the host the renderer
 * pin covers, and the only place voice.join may send the call (spec §4, §8.2).
 */
export type RendererWelcome = Omit<WelcomePayload, 'fileToken'> & { serverId: string; address: string };

export interface ProbeResult {
  serverKeyId: string;
  fingerprint: string;
}

export interface JoinConnectRequest {
  addresses: string[];
  serverKeyId: string;
  inviteCode?: string;
  password?: string;
  setupCode?: string;
  nickname: string;
  name?: string;
}

export interface BackupExportResult {
  saved: boolean;
  fileName: string | null;
}

export interface BackupPickResult {
  picked: boolean;
  fileName: string | null;
}

/** A desktop notification for a mention or a reply (spec §11.1 item 8). */
export interface ChatNotification {
  title: string;
  body: string;
  channelId: string;
}

/** Sent when the user clicks a chat notification. */
export interface OpenChannelEvent {
  channelId: string;
}

/** Push-to-talk as the renderer configures it; `code` is a DOM KeyboardEvent.code (voice track). */
export interface PttConfig {
  enabled: boolean;
  code: string | null;
}

/** Whether the bound key also works while another app has focus (global hook, Windows). */
export interface PttStatus {
  global: boolean;
}

/** The bound push-to-talk key went down or up while another app had focus. */
export interface PttEvent {
  pressed: boolean;
}

export interface ConnectionStateEvent {
  state: ConnState;
  serverId: string | null;
  error?: AppErrorCode;
  /** With SERVER_DELETING: when the server is erased (ms epoch, the server's clock), when it said. */
  deletingAt?: number;
  /**
   * The voice call's connection while another server (or the Home screen) is on screen
   * (chamada-continua §2): the screen's connection state ignores it; the call follows it.
   */
  background?: true;
}

/** What `IPC_EVENTS.server` carries: a server event and the saved server it came from. */
export interface ServerEventMessage {
  serverId: string;
  event: Envelope;
}

/**
 * What "Sair do servidor" finds on a saved server that is not open (leave/delete spec §2, §3):
 * a member (the leave dialog), the owner (the delete dialog, when the server can delete itself),
 * a server being deleted or already erased, or no answer ("Tirar só da minha lista").
 */
export type ServerExitCheck =
  | { kind: 'member' }
  | { kind: 'owner'; name: string; canDelete: boolean; deletingAt: number | null }
  | { kind: 'deleting'; at: number | null }
  | { kind: 'deleted' }
  | { kind: 'unreachable'; code: AppErrorCode };

export interface GhostlinkApi {
  app: {
    info(): Promise<AppInfo>;
    /** Opens an http(s) link in the browser after a confirmation dialog; false when refused or cancelled. */
    openExternal(url: string): Promise<boolean>;
    copyText(text: string): Promise<void>;
  };
  identity: {
    status(): Promise<IdentityStatus>;
    create(): Promise<void>;
    retry(): Promise<IdentityStatus>;
    replaceKeepingBackup(): Promise<void>;
    /** spec §3.4: asks where to save, then writes the .ghostkey (password ≥ 8 characters). */
    exportBackup(password: string): Promise<BackupExportResult>;
    /** Opens the file dialog; the file is checked and kept in the main process. */
    pickBackup(): Promise<BackupPickResult>;
    /** Decrypts the picked file and replaces the identity (`replace` = the user confirmed twice). */
    importBackup(password: string, replace: boolean): Promise<IdentityStatus>;
    /** spec §3.1: takes the identity out of use; main keeps identity.bin as identity.bin.bak-… (after a double confirmation). */
    delete(): Promise<IdentityStatus>;
  };
  settings: { get(): Promise<Settings>; set(patch: Partial<Settings>): Promise<Settings> };
  join: {
    parse(input: string): Promise<ParsedJoinInput>;
    probe(address: string): Promise<ProbeResult>;
    connect(req: JoinConnectRequest): Promise<RendererWelcome>;
  };
  servers: {
    list(): Promise<SavedServer[]>;
    connect(id: string): Promise<RendererWelcome>;
    disconnect(): Promise<void>;
    /** Takes a saved server out of the list only (the fallback when it cannot be reached). */
    remove(id: string): Promise<void>;
    /** Connects (a short connection of its own unless it is the open server) to see what leaving it means. */
    checkExit(id: string): Promise<ServerExitCheck>;
    /** `server.leave`, then out of the list. */
    leave(id: string, deleteMyMessages: boolean): Promise<void>;
    /** The owner's `server.delete`: offline now, erased at `at` (ms epoch, the server's clock). */
    delete(id: string): Promise<{ at: number }>;
    /**
     * The voice call runs on this saved server (null: it ended). Its connection then outlives
     * a switch to another server or to the Home screen (chamada-continua §2).
     */
    setCall(serverId: string | null): Promise<void>;
  };
  host: HostApi;
  onConnectionState(cb: (s: ConnectionStateEvent) => void): () => void;
  /** Every connected server's events, with the saved server they came from (on screen or the call's). */
  onServerEvent(cb: (e: Envelope, serverId: string) => void): () => void;
  onHostStatus(cb: (s: HostStatus) => void): () => void;
  /** spec §12: a ghostlink:// link that arrived before the page listened (then null). */
  deepLink: { take(): Promise<ParsedJoinInput | null> };
  onDeepLink(cb: (link: ParsedJoinInput) => void): () => void;
  /**
   * A client request of spec §5.2. With `serverId` it goes to that saved server's connection
   * (on screen or the call's), and is refused when neither is that server; without it, to the
   * server on screen.
   */
  server: { request<T = unknown>(type: string, payload?: unknown, serverId?: string): Promise<T> };
  notifications: { show(n: ChatNotification): Promise<boolean> };
  onOpenChannel(cb: (e: OpenChannelEvent) => void): () => void;
  updates: UpdatesApi;
  ptt: { configure(config: PttConfig): Promise<PttStatus> };
  onPtt(cb: (e: PttEvent) => void): () => void;
  railway: RailwayApi;
  friends: FriendsApi;
  dm: DmApi;
  profile: ProfileApi;
  /** Files in server channels (spec 2026-10-01-anexos §4): upload to the server on screen, and "Baixar". */
  attachments: AttachmentsApi;
  screen: ScreenApi;
  /** The pencil's overlay over my shared monitor (pencil spec §4). */
  draw: DrawApi;
  /** Servers follow the app's version (spec 2026-10-01 §3, §5): the Railway servers this app created. */
  serverUpdates: ServerUpdatesApi;
}

/**
 * "Criar um servidor" → Railway (v0.2). The token goes in once (connect) and stays encrypted
 * in main; create/resume report each step through onProgress and end joined as the owner.
 */
export interface RailwayApi {
  status(): Promise<RailwayAccount>;
  /** Validates the token with Railway, then stores it encrypted (safeStorage). */
  connect(token: string): Promise<RailwayAccount>;
  /** Forgets the token (servers already created keep running). */
  disconnect(): Promise<RailwayAccount>;
  create(req: RailwayCreateRequest): Promise<RendererWelcome>;
  pending(): Promise<RailwayPending | null>;
  resume(): Promise<RendererWelcome>;
  /** Deletes the unfinished provisioning's Railway project. */
  discard(): Promise<void>;
  onProgress(cb: (p: RailwayProgress) => void): () => void;
}

/** Invoke channels: `ghostlink:<namespace>.<method>`. */
export const IPC = {
  appInfo: 'ghostlink:app.info',
  appOpenExternal: 'ghostlink:app.openExternal',
  appCopyText: 'ghostlink:app.copyText',
  serverRequest: 'ghostlink:server.request',
  notificationsShow: 'ghostlink:notifications.show',
  identityStatus: 'ghostlink:identity.status',
  identityCreate: 'ghostlink:identity.create',
  identityRetry: 'ghostlink:identity.retry',
  identityReplaceKeepingBackup: 'ghostlink:identity.replaceKeepingBackup',
  identityExportBackup: 'ghostlink:identity.exportBackup',
  identityPickBackup: 'ghostlink:identity.pickBackup',
  identityImportBackup: 'ghostlink:identity.importBackup',
  identityDelete: 'ghostlink:identity.delete',
  deepLinkTake: 'ghostlink:deepLink.take',
  settingsGet: 'ghostlink:settings.get',
  settingsSet: 'ghostlink:settings.set',
  joinParse: 'ghostlink:join.parse',
  joinProbe: 'ghostlink:join.probe',
  joinConnect: 'ghostlink:join.connect',
  serversList: 'ghostlink:servers.list',
  serversConnect: 'ghostlink:servers.connect',
  serversDisconnect: 'ghostlink:servers.disconnect',
  serversRemove: 'ghostlink:servers.remove',
  serversCheckExit: 'ghostlink:servers.checkExit',
  serversLeave: 'ghostlink:servers.leave',
  serversDelete: 'ghostlink:servers.delete',
  serversSetCall: 'ghostlink:servers.setCall',
  hostStatus: 'ghostlink:host.status',
  hostStart: 'ghostlink:host.start',
  hostStop: 'ghostlink:host.stop',
  hostRestart: 'ghostlink:host.restart',
  hostJoin: 'ghostlink:host.join',
  hostRecoverOwnership: 'ghostlink:host.recoverOwnership',
  hostInvite: 'ghostlink:host.invite',
  hostLogs: 'ghostlink:host.logs',
  hostCopyText: 'ghostlink:host.copyText',
  hostFirewall: 'ghostlink:host.firewall',
  hostFixFirewall: 'ghostlink:host.fixFirewall',
  updatesState: 'ghostlink:updates.state',
  updatesSetAutoCheck: 'ghostlink:updates.setAutoCheck',
  updatesCheckNow: 'ghostlink:updates.checkNow',
  updatesNotes: 'ghostlink:updates.notes',
  updatesRestart: 'ghostlink:updates.restart',
  pttConfigure: 'ghostlink:ptt.configure',
  railwayStatus: 'ghostlink:railway.status',
  railwayConnect: 'ghostlink:railway.connect',
  railwayDisconnect: 'ghostlink:railway.disconnect',
  railwayCreate: 'ghostlink:railway.create',
  railwayPending: 'ghostlink:railway.pending',
  railwayResume: 'ghostlink:railway.resume',
  railwayDiscard: 'ghostlink:railway.discard',
  friendsState: 'ghostlink:friends.state',
  friendsAdd: 'ghostlink:friends.add',
  friendsAccept: 'ghostlink:friends.accept',
  friendsDismiss: 'ghostlink:friends.dismiss',
  friendsRemove: 'ghostlink:friends.remove',
  friendsBlock: 'ghostlink:friends.block',
  friendsRename: 'ghostlink:friends.rename',
  friendsNewCode: 'ghostlink:friends.newCode',
  friendsSetInbox: 'ghostlink:friends.setInbox',
  friendsSetAvailable: 'ghostlink:friends.setAvailable',
  dmConversations: 'ghostlink:dm.conversations',
  dmOpen: 'ghostlink:dm.open',
  dmHide: 'ghostlink:dm.hide',
  dmHistory: 'ghostlink:dm.history',
  dmSend: 'ghostlink:dm.send',
  dmEdit: 'ghostlink:dm.edit',
  dmRemove: 'ghostlink:dm.remove',
  dmRead: 'ghostlink:dm.read',
  dmTyping: 'ghostlink:dm.typing',
  profileAvatar: 'ghostlink:profile.avatar',
  profileSetAvatar: 'ghostlink:profile.setAvatar',
  profileClearAvatar: 'ghostlink:profile.clearAvatar',
  attachmentsUpload: 'ghostlink:attachments.upload',
  attachmentsSave: 'ghostlink:attachments.save',
  screenSources: 'ghostlink:screen.sources',
  screenChoose: 'ghostlink:screen.choose',
  drawOverlayOpen: 'ghostlink:draw.overlayOpen',
  drawOverlayStroke: 'ghostlink:draw.overlayStroke',
  drawOverlayClose: 'ghostlink:draw.overlayClose',
  serverUpdatesState: 'ghostlink:serverUpdates.state',
  serverUpdatesUpdateNow: 'ghostlink:serverUpdates.updateNow',
} as const;

/** Events pushed from main to the renderer. */
export const IPC_EVENTS = {
  connectionState: 'ghostlink:event.connectionState',
  server: 'ghostlink:event.server',
  host: 'ghostlink:event.host',
  deepLink: 'ghostlink:event.deepLink',
  openChannel: 'ghostlink:event.openChannel',
  updates: 'ghostlink:event.updates',
  ptt: 'ghostlink:event.ptt',
  railway: 'ghostlink:event.railway',
  friends: 'ghostlink:event.friends',
  dm: 'ghostlink:event.dm',
  serverUpdates: 'ghostlink:event.serverUpdates',
  attachmentProgress: 'ghostlink:event.attachmentProgress',
} as const;

/** Arguments and result of every invoke channel; main's handlers and the preload are both typed from it. */
export interface IpcContract {
  [IPC.appInfo]: { args: []; result: AppInfo };
  [IPC.appOpenExternal]: { args: [url: string]; result: boolean };
  [IPC.appCopyText]: { args: [text: string]; result: void };
  [IPC.serverRequest]: { args: [type: string, payload?: unknown, serverId?: string]; result: unknown };
  [IPC.notificationsShow]: { args: [notification: ChatNotification]; result: boolean };
  [IPC.identityStatus]: { args: []; result: IdentityStatus };
  [IPC.identityCreate]: { args: []; result: void };
  [IPC.identityRetry]: { args: []; result: IdentityStatus };
  [IPC.identityReplaceKeepingBackup]: { args: []; result: void };
  [IPC.identityExportBackup]: { args: [password: string]; result: BackupExportResult };
  [IPC.identityPickBackup]: { args: []; result: BackupPickResult };
  [IPC.identityImportBackup]: { args: [password: string, replace: boolean]; result: IdentityStatus };
  [IPC.identityDelete]: { args: []; result: IdentityStatus };
  [IPC.deepLinkTake]: { args: []; result: ParsedJoinInput | null };
  [IPC.settingsGet]: { args: []; result: Settings };
  [IPC.settingsSet]: { args: [patch: Partial<Settings>]; result: Settings };
  [IPC.joinParse]: { args: [input: string]; result: ParsedJoinInput };
  [IPC.joinProbe]: { args: [address: string]; result: ProbeResult };
  [IPC.joinConnect]: { args: [req: JoinConnectRequest]; result: RendererWelcome };
  [IPC.serversList]: { args: []; result: SavedServer[] };
  [IPC.serversConnect]: { args: [id: string]; result: RendererWelcome };
  [IPC.serversDisconnect]: { args: []; result: void };
  [IPC.serversRemove]: { args: [id: string]; result: void };
  [IPC.serversCheckExit]: { args: [id: string]; result: ServerExitCheck };
  [IPC.serversLeave]: { args: [id: string, deleteMyMessages: boolean]; result: void };
  [IPC.serversDelete]: { args: [id: string]; result: { at: number } };
  [IPC.serversSetCall]: { args: [serverId: string | null]; result: void };
  [IPC.hostStatus]: { args: []; result: HostStatus };
  [IPC.hostStart]: { args: [config: HostConfig]; result: HostStartResult };
  [IPC.hostStop]: { args: []; result: HostStatus };
  [IPC.hostRestart]: { args: []; result: HostStartResult };
  [IPC.hostJoin]: { args: []; result: HostStartResult };
  [IPC.hostRecoverOwnership]: { args: []; result: HostStartResult };
  [IPC.hostInvite]: { args: [opts: HostInviteOptions]; result: HostInvite };
  [IPC.hostLogs]: { args: []; result: string[] };
  [IPC.hostCopyText]: { args: [text: string]; result: void };
  [IPC.hostFirewall]: { args: []; result: FirewallStatus };
  [IPC.hostFixFirewall]: { args: []; result: { result: FirewallFixResult; status: FirewallStatus } };
  [IPC.updatesState]: { args: []; result: UpdateState };
  [IPC.updatesSetAutoCheck]: { args: [enabled: boolean]; result: UpdateState };
  [IPC.updatesCheckNow]: { args: []; result: UpdateState };
  [IPC.updatesNotes]: { args: [version: string]; result: ReleaseNotesResult };
  [IPC.updatesRestart]: { args: []; result: void };
  [IPC.pttConfigure]: { args: [config: PttConfig]; result: PttStatus };
  [IPC.railwayStatus]: { args: []; result: RailwayAccount };
  [IPC.railwayConnect]: { args: [token: string]; result: RailwayAccount };
  [IPC.railwayDisconnect]: { args: []; result: RailwayAccount };
  [IPC.railwayCreate]: { args: [req: RailwayCreateRequest]; result: RendererWelcome };
  [IPC.railwayPending]: { args: []; result: RailwayPending | null };
  [IPC.railwayResume]: { args: []; result: RendererWelcome };
  [IPC.railwayDiscard]: { args: []; result: void };
  [IPC.friendsState]: { args: []; result: FriendsSnapshot };
  [IPC.friendsAdd]: { args: [code: string]; result: FriendsSnapshot };
  [IPC.friendsAccept]: { args: [key: string]; result: FriendsSnapshot };
  [IPC.friendsDismiss]: { args: [key: string]; result: FriendsSnapshot };
  [IPC.friendsRemove]: { args: [key: string]; result: FriendsSnapshot };
  [IPC.friendsBlock]: { args: [key: string]; result: FriendsSnapshot };
  [IPC.friendsRename]: { args: [key: string, localName: string | null]; result: FriendsSnapshot };
  [IPC.friendsNewCode]: { args: []; result: FriendsSnapshot };
  [IPC.friendsSetInbox]: { args: [enabled: boolean]; result: FriendsSnapshot };
  [IPC.friendsSetAvailable]: { args: [enabled: boolean]; result: FriendsSnapshot };
  [IPC.dmConversations]: { args: []; result: DmConversation[] };
  [IPC.dmOpen]: { args: [friendKey: string]; result: DmConversation };
  [IPC.dmHide]: { args: [conv: string]; result: void };
  [IPC.dmHistory]: { args: [conv: string, before: number | null, limit: number]; result: DmMessage[] };
  [IPC.dmSend]: { args: [conv: string, text: string, replyTo: string | null]; result: DmMessage };
  [IPC.dmEdit]: { args: [conv: string, id: string, text: string]; result: DmMessage };
  [IPC.dmRemove]: { args: [conv: string, id: string]; result: DmMessage };
  [IPC.dmRead]: { args: [conv: string, ts: number]; result: void };
  [IPC.dmTyping]: { args: [conv: string]; result: void };
  [IPC.profileAvatar]: { args: []; result: AvatarInfo | null };
  [IPC.profileSetAvatar]: { args: [bytes: Uint8Array]; result: AvatarInfo };
  [IPC.profileClearAvatar]: { args: []; result: null };
  [IPC.attachmentsUpload]: { args: [uploadId: string, serverId: string, channelId: string, name: string, bytes: Uint8Array]; result: UploadResult };
  [IPC.attachmentsSave]: { args: [src: string, name: string]; result: SaveResult };
  [IPC.screenSources]: { args: []; result: ScreenSource[] };
  [IPC.screenChoose]: { args: [choice: ScreenChoice]; result: void };
  [IPC.drawOverlayOpen]: { args: []; result: boolean };
  [IPC.drawOverlayStroke]: { args: [stroke: OverlayStroke]; result: void };
  [IPC.drawOverlayClose]: { args: []; result: void };
  [IPC.serverUpdatesState]: { args: [serverKeyId: string]; result: ManagedServerUpdate | null };
  [IPC.serverUpdatesUpdateNow]: { args: [serverKeyId: string]; result: ManagedServerUpdate };
}

/** The attachment channels (v0.3.3), handled by main/attachments/attachmentsIpc.ts. */
export type AttachmentsIpcChannel = Extract<IpcChannel, `ghostlink:attachments.${string}`>;

/** The profile photo channels (v0.2.2), handled by main/profileIpc.ts. */
export type ProfileIpcChannel = Extract<IpcChannel, `ghostlink:profile.${string}`>;

/** The update of the Railway servers this app created (v0.2.2), handled by main/serverUpdatesIpc.ts. */
export type ServerUpdatesIpcChannel = Extract<IpcChannel, `ghostlink:serverUpdates.${string}`>;

/** The direct-message channels (v0.3 phase 2), handled by main/dmIpc.ts. */
export type DmIpcChannel = Extract<IpcChannel, `ghostlink:dm.${string}`>;

/** The friends channels (v0.3), handled by main/friendsIpc.ts. */
export type FriendsIpcChannel = Extract<IpcChannel, `ghostlink:friends.${string}`>;

/** The Railway provisioning channels (v0.2), handled by main/railwayIpc.ts. */
export type RailwayIpcChannel = Extract<IpcChannel, `ghostlink:railway.${string}`>;

/** The Host mode channels (spec §9), handled by main/hostIpc.ts. */
export type HostIpcChannel = Extract<IpcChannel, `ghostlink:host.${string}`>;

/** The identity backup channels (spec §3.4), handled by main/backup.ts. */
export type BackupIpcChannel =
  | typeof IPC.identityExportBackup
  | typeof IPC.identityPickBackup
  | typeof IPC.identityImportBackup
  | typeof IPC.identityDelete;

export type IpcChannel = keyof IpcContract;
export type IpcArgs<C extends IpcChannel> = IpcContract[C]['args'];
export type IpcReturn<C extends IpcChannel> = IpcContract[C]['result'];

/** What every invoke handler resolves with; the preload turns `ok: false` into `new Error(code)`. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; code: AppErrorCode };
