// Sandboxed preload (spec §12): the whole renderer API, nothing else. It imports
// only `electron` and type-only modules, so the bundle stays a single CJS file.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Envelope, ParsedJoinInput } from '@ghostlink/shared';
import {
  IPC,
  IPC_EVENTS,
  type ConnectionStateEvent,
  type OpenChannelEvent,
  type GhostlinkApi,
  type IpcArgs,
  type IpcChannel,
  type IpcResult,
  type IpcReturn,
} from '../shared/ipcTypes.js';
import type { HostStatus } from '../shared/hostTypes.js';
import type { UpdateState } from '../shared/updates.js';

/** Invokes a channel and turns `{ ok: false, code }` into `Error(code)` (contract §5: the message is the code). */
async function invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcReturn<C>> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<IpcReturn<C>>;
  if (result.ok) return result.value;
  throw new Error(result.code);
}

/** Subscribes to a main → renderer event; the page never sees the IpcRendererEvent. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

export const api: GhostlinkApi = {
  app: {
    info: () => invoke(IPC.appInfo),
    openExternal: (url) => invoke(IPC.appOpenExternal, url),
    copyText: (text) => invoke(IPC.appCopyText, text),
  },
  identity: {
    status: () => invoke(IPC.identityStatus),
    create: () => invoke(IPC.identityCreate),
    retry: () => invoke(IPC.identityRetry),
    replaceKeepingBackup: () => invoke(IPC.identityReplaceKeepingBackup),
    exportBackup: (password) => invoke(IPC.identityExportBackup, password),
    pickBackup: () => invoke(IPC.identityPickBackup),
    importBackup: (password, replace) => invoke(IPC.identityImportBackup, password, replace),
    delete: () => invoke(IPC.identityDelete),
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    set: (patch) => invoke(IPC.settingsSet, patch),
  },
  join: {
    parse: (input) => invoke(IPC.joinParse, input),
    probe: (address) => invoke(IPC.joinProbe, address),
    connect: (req) => invoke(IPC.joinConnect, req),
  },
  servers: {
    list: () => invoke(IPC.serversList),
    connect: (id) => invoke(IPC.serversConnect, id),
    disconnect: () => invoke(IPC.serversDisconnect),
    remove: (id) => invoke(IPC.serversRemove, id),
  },
  host: {
    status: () => invoke(IPC.hostStatus),
    start: (config) => invoke(IPC.hostStart, config),
    stop: () => invoke(IPC.hostStop),
    restart: () => invoke(IPC.hostRestart),
    join: () => invoke(IPC.hostJoin),
    recoverOwnership: () => invoke(IPC.hostRecoverOwnership),
    invite: (opts) => invoke(IPC.hostInvite, opts),
    logs: () => invoke(IPC.hostLogs),
    copyText: (text) => invoke(IPC.hostCopyText, text),
    firewall: () => invoke(IPC.hostFirewall),
    fixFirewall: () => invoke(IPC.hostFixFirewall),
  },
  onConnectionState: (cb) => subscribe<ConnectionStateEvent>(IPC_EVENTS.connectionState, cb),
  onServerEvent: (cb) => subscribe<Envelope>(IPC_EVENTS.server, cb),
  onHostStatus: (cb) => subscribe<HostStatus>(IPC_EVENTS.host, cb),
  deepLink: { take: () => invoke(IPC.deepLinkTake) },
  onDeepLink: (cb) => subscribe<ParsedJoinInput>(IPC_EVENTS.deepLink, cb),
  server: {
    request: <T>(type: string, payload?: unknown, serverId?: string) =>
      (serverId === undefined ? invoke(IPC.serverRequest, type, payload) : invoke(IPC.serverRequest, type, payload, serverId)) as Promise<T>,
  },
  notifications: { show: (n) => invoke(IPC.notificationsShow, n) },
  onOpenChannel: (cb) => subscribe<OpenChannelEvent>(IPC_EVENTS.openChannel, cb),
  updates: {
    state: () => invoke(IPC.updatesState),
    setAutoCheck: (enabled) => invoke(IPC.updatesSetAutoCheck, enabled),
    restart: () => invoke(IPC.updatesRestart),
    onState: (cb) => subscribe<UpdateState>(IPC_EVENTS.updates, cb),
  },
};

contextBridge.exposeInMainWorld('ghostlink', api);
