// Sandboxed preload (spec §12): the whole renderer API, nothing else. It imports
// only `electron` and type-only modules, so the bundle stays a single CJS file.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ParsedJoinInput } from '@ghostlink/shared';
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
  type PttEvent,
  type ServerEventMessage,
} from '../shared/ipcTypes.js';
import type { UploadProgressEvent } from '../shared/attachmentTypes.js';
import type { DmEvent } from '../shared/dmTypes.js';
import type { FriendsSnapshot } from '../shared/friendsTypes.js';
import type { HostStatus } from '../shared/hostTypes.js';
import type { RailwayProgress } from '../shared/railwayTypes.js';
import type { ManagedServerUpdate } from '../shared/serverUpdateTypes.js';
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
    checkExit: (id) => invoke(IPC.serversCheckExit, id),
    leave: (id, deleteMyMessages) => invoke(IPC.serversLeave, id, deleteMyMessages),
    delete: (id) => invoke(IPC.serversDelete, id),
    setCall: (serverId) => invoke(IPC.serversSetCall, serverId),
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
  onServerEvent: (cb) => subscribe<ServerEventMessage>(IPC_EVENTS.server, (m) => cb(m.event, m.serverId)),
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
    checkNow: () => invoke(IPC.updatesCheckNow),
    notes: (version) => invoke(IPC.updatesNotes, version),
    restart: () => invoke(IPC.updatesRestart),
    onState: (cb) => subscribe<UpdateState>(IPC_EVENTS.updates, cb),
  },
  ptt: { configure: (config) => invoke(IPC.pttConfigure, config) },
  onPtt: (cb) => subscribe<PttEvent>(IPC_EVENTS.ptt, cb),
  railway: {
    status: () => invoke(IPC.railwayStatus),
    connect: (token) => invoke(IPC.railwayConnect, token),
    disconnect: () => invoke(IPC.railwayDisconnect),
    create: (req) => invoke(IPC.railwayCreate, req),
    pending: () => invoke(IPC.railwayPending),
    resume: () => invoke(IPC.railwayResume),
    discard: () => invoke(IPC.railwayDiscard),
    onProgress: (cb) => subscribe<RailwayProgress>(IPC_EVENTS.railway, cb),
  },
  friends: {
    state: () => invoke(IPC.friendsState),
    add: (code) => invoke(IPC.friendsAdd, code),
    accept: (key) => invoke(IPC.friendsAccept, key),
    dismiss: (key) => invoke(IPC.friendsDismiss, key),
    remove: (key) => invoke(IPC.friendsRemove, key),
    block: (key) => invoke(IPC.friendsBlock, key),
    rename: (key, localName) => invoke(IPC.friendsRename, key, localName),
    newCode: () => invoke(IPC.friendsNewCode),
    setInbox: (enabled) => invoke(IPC.friendsSetInbox, enabled),
    setAvailable: (enabled) => invoke(IPC.friendsSetAvailable, enabled),
    onChange: (cb) => subscribe<FriendsSnapshot>(IPC_EVENTS.friends, cb),
  },
  dm: {
    conversations: () => invoke(IPC.dmConversations),
    open: (friendKey) => invoke(IPC.dmOpen, friendKey),
    hide: (conv) => invoke(IPC.dmHide, conv),
    history: (conv, before, limit) => invoke(IPC.dmHistory, conv, before, limit),
    send: (conv, text, replyTo, files = []) => invoke(IPC.dmSend, conv, text, replyTo, files),
    edit: (conv, id, text) => invoke(IPC.dmEdit, conv, id, text),
    remove: (conv, id) => invoke(IPC.dmRemove, conv, id),
    read: (conv, ts) => invoke(IPC.dmRead, conv, ts),
    typing: (conv) => invoke(IPC.dmTyping, conv),
    attach: (conv, name, bytes) => invoke(IPC.dmAttach, conv, name, bytes),
    fetchFile: (conv, hash) => invoke(IPC.dmFetchFile, conv, hash),
    saveFile: (conv, hash) => invoke(IPC.dmSaveFile, conv, hash),
    onEvent: (cb) => subscribe<DmEvent>(IPC_EVENTS.dm, cb),
  },
  profile: {
    avatar: () => invoke(IPC.profileAvatar),
    setAvatar: (bytes) => invoke(IPC.profileSetAvatar, bytes),
    clearAvatar: () => invoke(IPC.profileClearAvatar),
    setServerIcon: (serverId, bytes) => invoke(IPC.profileSetServerIcon, serverId, bytes),
  },
  attachments: {
    upload: (uploadId, serverId, channelId, name, bytes) => invoke(IPC.attachmentsUpload, uploadId, serverId, channelId, name, bytes),
    save: (src, name) => invoke(IPC.attachmentsSave, src, name),
    onProgress: (cb) => subscribe<UploadProgressEvent>(IPC_EVENTS.attachmentProgress, cb),
  },
  screen: {
    sources: () => invoke(IPC.screenSources),
    choose: (choice) => invoke(IPC.screenChoose, choice),
  },
  draw: {
    overlayOpen: () => invoke(IPC.drawOverlayOpen),
    overlayStroke: (stroke) => invoke(IPC.drawOverlayStroke, stroke),
    overlayClose: () => invoke(IPC.drawOverlayClose),
  },
  serverUpdates: {
    state: (serverKeyId) => invoke(IPC.serverUpdatesState, serverKeyId),
    updateNow: (serverKeyId) => invoke(IPC.serverUpdatesUpdateNow, serverKeyId),
    onState: (cb) => subscribe<ManagedServerUpdate>(IPC_EVENTS.serverUpdates, cb),
  },
};

contextBridge.exposeInMainWorld('ghostlink', api);
