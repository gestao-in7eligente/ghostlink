// The typed contract between the main process, the preload script and the renderer
// (interface contract §5). Type-only imports keep this file free of runtime
// dependencies, so the sandboxed preload bundle stays tiny.
import type { Envelope, ParsedJoinInput, WelcomePayload } from '@ghostlink/shared';
import type { AppErrorCode } from './appErrors.js';

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

/** The welcome as the renderer sees it: never the fileToken (spec §3.1). */
export type RendererWelcome = Omit<WelcomePayload, 'fileToken'> & { serverId: string };

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

export interface ConnectionStateEvent {
  state: ConnState;
  serverId: string | null;
  error?: AppErrorCode;
}

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
    remove(id: string): Promise<void>;
  };
  /**
   * A client request of spec §5.2 to the connected server. With `serverId` (the saved
   * server the caller believes it talks to), main refuses it after a switch.
   */
  server: { request<T = unknown>(type: string, payload?: unknown, serverId?: string): Promise<T> };
  notifications: { show(n: ChatNotification): Promise<boolean> };
  onConnectionState(cb: (s: ConnectionStateEvent) => void): () => void;
  onServerEvent(cb: (e: Envelope) => void): () => void;
  onOpenChannel(cb: (e: OpenChannelEvent) => void): () => void;
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
  settingsGet: 'ghostlink:settings.get',
  settingsSet: 'ghostlink:settings.set',
  joinParse: 'ghostlink:join.parse',
  joinProbe: 'ghostlink:join.probe',
  joinConnect: 'ghostlink:join.connect',
  serversList: 'ghostlink:servers.list',
  serversConnect: 'ghostlink:servers.connect',
  serversDisconnect: 'ghostlink:servers.disconnect',
  serversRemove: 'ghostlink:servers.remove',
} as const;

/** Events pushed from main to the renderer. */
export const IPC_EVENTS = {
  connectionState: 'ghostlink:event.connectionState',
  server: 'ghostlink:event.server',
  openChannel: 'ghostlink:event.openChannel',
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
  [IPC.settingsGet]: { args: []; result: Settings };
  [IPC.settingsSet]: { args: [patch: Partial<Settings>]; result: Settings };
  [IPC.joinParse]: { args: [input: string]; result: ParsedJoinInput };
  [IPC.joinProbe]: { args: [address: string]; result: ProbeResult };
  [IPC.joinConnect]: { args: [req: JoinConnectRequest]; result: RendererWelcome };
  [IPC.serversList]: { args: []; result: SavedServer[] };
  [IPC.serversConnect]: { args: [id: string]; result: RendererWelcome };
  [IPC.serversDisconnect]: { args: []; result: void };
  [IPC.serversRemove]: { args: [id: string]; result: void };
}

export type IpcChannel = keyof IpcContract;
export type IpcArgs<C extends IpcChannel> = IpcContract[C]['args'];
export type IpcReturn<C extends IpcChannel> = IpcContract[C]['result'];

/** What every invoke handler resolves with; the preload turns `ok: false` into `new Error(code)`. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; code: AppErrorCode };
