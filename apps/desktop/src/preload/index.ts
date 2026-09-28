// Sandboxed preload (spec §12): the whole renderer API, nothing else. It imports
// only `electron` and type-only modules, so the bundle stays a single CJS file.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Envelope } from '@ghostlink/shared';
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
  server: {
    request: <T>(type: string, payload?: unknown) => invoke(IPC.serverRequest, type, payload) as Promise<T>,
  },
  notifications: { show: (n) => invoke(IPC.notificationsShow, n) },
  onConnectionState: (cb) => subscribe<ConnectionStateEvent>(IPC_EVENTS.connectionState, cb),
  onServerEvent: (cb) => subscribe<Envelope>(IPC_EVENTS.server, cb),
  onOpenChannel: (cb) => subscribe<OpenChannelEvent>(IPC_EVENTS.openChannel, cb),
};

contextBridge.exposeInMainWorld('ghostlink', api);
