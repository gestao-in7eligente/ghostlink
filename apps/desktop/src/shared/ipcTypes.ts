// The typed contract between the main process, the preload script and the renderer
// (interface contract §5). Type-only imports keep this file free of runtime
// dependencies, so the sandboxed preload bundle stays tiny.
import type { Envelope, ParsedJoinInput, WelcomePayload } from '@ghostlink/shared';
import type { AppErrorCode } from './appErrors.js';
import type { FirewallFixResult, FirewallStatus, HostApi, HostConfig, HostInvite, HostInviteOptions, HostStartResult, HostStatus } from './hostTypes.js';

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

export interface BackupExportResult {
  saved: boolean;
  fileName: string | null;
}

export interface BackupPickResult {
  picked: boolean;
  fileName: string | null;
}

export interface ConnectionStateEvent {
  state: ConnState;
  serverId: string | null;
  error?: AppErrorCode;
}

export interface GhostlinkApi {
  app: { info(): Promise<AppInfo> };
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
    /** spec §3.1: removes the identity from this device (after a double confirmation). */
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
    remove(id: string): Promise<void>;
  };
  host: HostApi;
  onConnectionState(cb: (s: ConnectionStateEvent) => void): () => void;
  onServerEvent(cb: (e: Envelope) => void): () => void;
  onHostStatus(cb: (s: HostStatus) => void): () => void;
}

/** Invoke channels: `ghostlink:<namespace>.<method>`. */
export const IPC = {
  appInfo: 'ghostlink:app.info',
  identityStatus: 'ghostlink:identity.status',
  identityCreate: 'ghostlink:identity.create',
  identityRetry: 'ghostlink:identity.retry',
  identityReplaceKeepingBackup: 'ghostlink:identity.replaceKeepingBackup',
  identityExportBackup: 'ghostlink:identity.exportBackup',
  identityPickBackup: 'ghostlink:identity.pickBackup',
  identityImportBackup: 'ghostlink:identity.importBackup',
  identityDelete: 'ghostlink:identity.delete',
  settingsGet: 'ghostlink:settings.get',
  settingsSet: 'ghostlink:settings.set',
  joinParse: 'ghostlink:join.parse',
  joinProbe: 'ghostlink:join.probe',
  joinConnect: 'ghostlink:join.connect',
  serversList: 'ghostlink:servers.list',
  serversConnect: 'ghostlink:servers.connect',
  serversDisconnect: 'ghostlink:servers.disconnect',
  serversRemove: 'ghostlink:servers.remove',
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
} as const;

/** Events pushed from main to the renderer. */
export const IPC_EVENTS = {
  connectionState: 'ghostlink:event.connectionState',
  server: 'ghostlink:event.server',
  host: 'ghostlink:event.host',
} as const;

/** Arguments and result of every invoke channel; main's handlers and the preload are both typed from it. */
export interface IpcContract {
  [IPC.appInfo]: { args: []; result: AppInfo };
  [IPC.identityStatus]: { args: []; result: IdentityStatus };
  [IPC.identityCreate]: { args: []; result: void };
  [IPC.identityRetry]: { args: []; result: IdentityStatus };
  [IPC.identityReplaceKeepingBackup]: { args: []; result: void };
  [IPC.identityExportBackup]: { args: [password: string]; result: BackupExportResult };
  [IPC.identityPickBackup]: { args: []; result: BackupPickResult };
  [IPC.identityImportBackup]: { args: [password: string, replace: boolean]; result: IdentityStatus };
  [IPC.identityDelete]: { args: []; result: IdentityStatus };
  [IPC.settingsGet]: { args: []; result: Settings };
  [IPC.settingsSet]: { args: [patch: Partial<Settings>]; result: Settings };
  [IPC.joinParse]: { args: [input: string]; result: ParsedJoinInput };
  [IPC.joinProbe]: { args: [address: string]; result: ProbeResult };
  [IPC.joinConnect]: { args: [req: JoinConnectRequest]; result: RendererWelcome };
  [IPC.serversList]: { args: []; result: SavedServer[] };
  [IPC.serversConnect]: { args: [id: string]; result: RendererWelcome };
  [IPC.serversDisconnect]: { args: []; result: void };
  [IPC.serversRemove]: { args: [id: string]; result: void };
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
}

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
