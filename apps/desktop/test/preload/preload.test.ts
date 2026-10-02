import { describe, expect, it, vi } from 'vitest';
import { IPC, IPC_EVENTS } from '../../src/shared/ipcTypes.js';

// Vitest clears mock.calls before each test (clearMocks), so what the preload exposes
// at import time is captured by the implementation itself.
const electron = vi.hoisted(() => {
  const exposed: Record<string, unknown> = {};
  return {
    exposed,
    contextBridge: { exposeInMainWorld: vi.fn((key: string, value: unknown) => { exposed[key] = value; }) },
    ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  };
});
vi.mock('electron', () => electron);

const { api } = await import('../../src/preload/index.js');

describe('preload bridge', () => {
  it('exposes exactly the contract API as window.ghostlink', () => {
    expect(Object.keys(electron.exposed)).toEqual(['ghostlink']);
    expect(electron.exposed.ghostlink).toBe(api);
    expect(Object.keys(api).sort()).toEqual([
      'app', 'attachments', 'deepLink', 'dm', 'draw', 'friends', 'host', 'identity', 'join', 'notifications', 'onConnectionState', 'onDeepLink', 'onHostStatus', 'onOpenChannel', 'onPtt', 'onServerEvent', 'profile', 'ptt', 'railway', 'screen', 'server', 'serverUpdates', 'servers', 'settings', 'updates',
    ]);
    expect(Object.keys(api.host).sort()).toEqual(['copyText', 'firewall', 'fixFirewall', 'invite', 'join', 'logs', 'recoverOwnership', 'restart', 'start', 'status', 'stop']);
    expect(Object.keys(api.app).sort()).toEqual(['copyText', 'info', 'openExternal']);
    expect(Object.keys(api.server)).toEqual(['request']);
    expect(Object.keys(api.notifications)).toEqual(['show']);
    expect(Object.keys(api.identity).sort()).toEqual(['create', 'delete', 'exportBackup', 'importBackup', 'pickBackup', 'replaceKeepingBackup', 'retry', 'status']);
    expect(Object.keys(api.ptt)).toEqual(['configure']);
    expect(Object.keys(api.join).sort()).toEqual(['connect', 'parse', 'probe']);
    expect(Object.keys(api.servers).sort()).toEqual(['checkExit', 'connect', 'delete', 'disconnect', 'leave', 'list', 'remove', 'setCall']);
    expect(Object.keys(api.settings).sort()).toEqual(['get', 'set']);
    expect(Object.keys(api.dm).sort()).toEqual(['attach', 'conversations', 'edit', 'fetchFile', 'hide', 'history', 'onEvent', 'open', 'read', 'remove', 'saveFile', 'send', 'typing']);
    expect(Object.keys(api.friends).sort()).toEqual(['accept', 'add', 'block', 'dismiss', 'newCode', 'onChange', 'remove', 'rename', 'setAvailable', 'setInbox', 'state']);
    expect(Object.keys(api.updates).sort()).toEqual(['checkNow', 'notes', 'onState', 'restart', 'setAutoCheck', 'state']);
    expect(Object.keys(api.screen).sort()).toEqual(['choose', 'sources']);
    expect(Object.keys(api.draw).sort()).toEqual(['overlayClose', 'overlayOpen', 'overlayStroke']);
    expect(Object.keys(api.railway).sort()).toEqual(['connect', 'create', 'discard', 'disconnect', 'onProgress', 'pending', 'resume', 'status']);
    expect(Object.keys(api.profile).sort()).toEqual(['avatar', 'clearAvatar', 'setAvatar', 'setBotAvatar', 'setServerIcon']);
    expect(Object.keys(api.attachments).sort()).toEqual(['onProgress', 'save', 'upload']);
    expect(Object.keys(api.serverUpdates).sort()).toEqual(['onState', 'state', 'updateNow']);
  });

  const req = { addresses: ['10.0.0.1:7700'], serverKeyId: 'k'.repeat(43), nickname: 'Ana' };
  const overlayStroke = { id: `${'a'.repeat(32)}:s1`, color: '#ff6b6b', label: 'Bia', points: [[0.5, 0.5]] as [number, number][], end: true };
  const hostConfig = { name: 'Casa', port: 7700, joinMode: 'invite' as const, maxMembers: 100 };
  const bytes = new Uint8Array([1, 2, 3]);
  it.each<[string, () => Promise<unknown>, string, unknown[]]>([
    ['app.info', () => api.app.info(), IPC.appInfo, []],
    ['identity.status', () => api.identity.status(), IPC.identityStatus, []],
    ['identity.create', () => api.identity.create(), IPC.identityCreate, []],
    ['identity.retry', () => api.identity.retry(), IPC.identityRetry, []],
    ['identity.replaceKeepingBackup', () => api.identity.replaceKeepingBackup(), IPC.identityReplaceKeepingBackup, []],
    ['identity.exportBackup', () => api.identity.exportBackup('password1'), IPC.identityExportBackup, ['password1']],
    ['identity.pickBackup', () => api.identity.pickBackup(), IPC.identityPickBackup, []],
    ['identity.importBackup', () => api.identity.importBackup('password1', true), IPC.identityImportBackup, ['password1', true]],
    ['identity.delete', () => api.identity.delete(), IPC.identityDelete, []],
    ['settings.get', () => api.settings.get(), IPC.settingsGet, []],
    ['settings.set', () => api.settings.set({ locale: 'en' }), IPC.settingsSet, [{ locale: 'en' }]],
    ['join.parse', () => api.join.parse('GL1-x'), IPC.joinParse, ['GL1-x']],
    ['join.probe', () => api.join.probe('10.0.0.1:7700'), IPC.joinProbe, ['10.0.0.1:7700']],
    ['join.connect', () => api.join.connect(req), IPC.joinConnect, [req]],
    ['servers.list', () => api.servers.list(), IPC.serversList, []],
    ['servers.connect', () => api.servers.connect('s1'), IPC.serversConnect, ['s1']],
    ['servers.disconnect', () => api.servers.disconnect(), IPC.serversDisconnect, []],
    ['servers.remove', () => api.servers.remove('s1'), IPC.serversRemove, ['s1']],
    ['servers.checkExit', () => api.servers.checkExit('s1'), IPC.serversCheckExit, ['s1']],
    ['servers.leave', () => api.servers.leave('s1', true), IPC.serversLeave, ['s1', true]],
    ['servers.delete', () => api.servers.delete('s1'), IPC.serversDelete, ['s1']],
    ['servers.setCall', () => api.servers.setCall('s1'), IPC.serversSetCall, ['s1']],
    ['servers.setCall null', () => api.servers.setCall(null), IPC.serversSetCall, [null]],
    ['host.status', () => api.host.status(), IPC.hostStatus, []],
    ['host.start', () => api.host.start(hostConfig), IPC.hostStart, [hostConfig]],
    ['host.stop', () => api.host.stop(), IPC.hostStop, []],
    ['host.restart', () => api.host.restart(), IPC.hostRestart, []],
    ['host.join', () => api.host.join(), IPC.hostJoin, []],
    ['host.recoverOwnership', () => api.host.recoverOwnership(), IPC.hostRecoverOwnership, []],
    ['host.invite', () => api.host.invite({ maxUses: 1 }), IPC.hostInvite, [{ maxUses: 1 }]],
    ['host.logs', () => api.host.logs(), IPC.hostLogs, []],
    ['host.copyText', () => api.host.copyText('GL1-x'), IPC.hostCopyText, ['GL1-x']],
    ['host.firewall', () => api.host.firewall(), IPC.hostFirewall, []],
    ['deepLink.take', () => api.deepLink.take(), IPC.deepLinkTake, []],
    ['host.fixFirewall', () => api.host.fixFirewall(), IPC.hostFixFirewall, []],
    ['app.openExternal', () => api.app.openExternal('https://x/'), IPC.appOpenExternal, ['https://x/']],
    ['app.copyText', () => api.app.copyText('abc'), IPC.appCopyText, ['abc']],
    ['server.request', () => api.server.request('msg.send', { a: 1 }), IPC.serverRequest, ['msg.send', { a: 1 }]],
    ['server.request for a server', () => api.server.request('msg.send', { a: 1 }, 'srv-1'), IPC.serverRequest, ['msg.send', { a: 1 }, 'srv-1']],
    ['notifications.show', () => api.notifications.show({ title: 't', body: 'b', channelId: 'c' }), IPC.notificationsShow, [{ title: 't', body: 'b', channelId: 'c' }]],
    ['updates.state', () => api.updates.state(), IPC.updatesState, []],
    ['updates.setAutoCheck', () => api.updates.setAutoCheck(false), IPC.updatesSetAutoCheck, [false]],
    ['updates.checkNow', () => api.updates.checkNow(), IPC.updatesCheckNow, []],
    ['updates.notes', () => api.updates.notes('0.2.3'), IPC.updatesNotes, ['0.2.3']],
    ['updates.restart', () => api.updates.restart(), IPC.updatesRestart, []],
    ['ptt.configure', () => api.ptt.configure({ enabled: true, code: 'KeyV' }), IPC.pttConfigure, [{ enabled: true, code: 'KeyV' }]],
    ['dm.conversations', () => api.dm.conversations(), IPC.dmConversations, []],
    ['dm.open', () => api.dm.open('k'), IPC.dmOpen, ['k']],
    ['dm.hide', () => api.dm.hide('c'), IPC.dmHide, ['c']],
    ['dm.history', () => api.dm.history('c', null, 50), IPC.dmHistory, ['c', null, 50]],
    ['dm.send', () => api.dm.send('c', 'oi', null), IPC.dmSend, ['c', 'oi', null, []]],
    ['dm.send with files', () => api.dm.send('c', '', null, [{ hash: 'h', name: 'a.png' }]), IPC.dmSend, ['c', '', null, [{ hash: 'h', name: 'a.png' }]]],
    ['dm.edit', () => api.dm.edit('c', 'm', 'oi!'), IPC.dmEdit, ['c', 'm', 'oi!']],
    ['dm.remove', () => api.dm.remove('c', 'm'), IPC.dmRemove, ['c', 'm']],
    ['dm.read', () => api.dm.read('c', 5), IPC.dmRead, ['c', 5]],
    ['dm.typing', () => api.dm.typing('c'), IPC.dmTyping, ['c']],
    ['dm.attach', () => api.dm.attach('c', 'a.png', new Uint8Array([1])), IPC.dmAttach, ['c', 'a.png', new Uint8Array([1])]],
    ['dm.fetchFile', () => api.dm.fetchFile('c', 'h'), IPC.dmFetchFile, ['c', 'h']],
    ['dm.saveFile', () => api.dm.saveFile('c', 'h'), IPC.dmSaveFile, ['c', 'h']],
    ['friends.state', () => api.friends.state(), IPC.friendsState, []],
    ['friends.add', () => api.friends.add('GLF1-AAAA'), IPC.friendsAdd, ['GLF1-AAAA']],
    ['friends.accept', () => api.friends.accept('k'), IPC.friendsAccept, ['k']],
    ['friends.dismiss', () => api.friends.dismiss('k'), IPC.friendsDismiss, ['k']],
    ['friends.remove', () => api.friends.remove('k'), IPC.friendsRemove, ['k']],
    ['friends.block', () => api.friends.block('k'), IPC.friendsBlock, ['k']],
    ['friends.rename', () => api.friends.rename('k', 'Bia'), IPC.friendsRename, ['k', 'Bia']],
    ['friends.newCode', () => api.friends.newCode(), IPC.friendsNewCode, []],
    ['friends.setInbox', () => api.friends.setInbox(false), IPC.friendsSetInbox, [false]],
    ['friends.setAvailable', () => api.friends.setAvailable(true), IPC.friendsSetAvailable, [true]],
    ['screen.sources', () => api.screen.sources(), IPC.screenSources, []],
    ['screen.choose', () => api.screen.choose({ sourceId: 'screen:0:0', audio: true }), IPC.screenChoose, [{ sourceId: 'screen:0:0', audio: true }]],
    ['draw.overlayOpen', () => api.draw.overlayOpen(), IPC.drawOverlayOpen, []],
    ['draw.overlayStroke', () => api.draw.overlayStroke(overlayStroke), IPC.drawOverlayStroke, [overlayStroke]],
    ['draw.overlayClose', () => api.draw.overlayClose(), IPC.drawOverlayClose, []],
    ['railway.status', () => api.railway.status(), IPC.railwayStatus, []],
    ['railway.connect', () => api.railway.connect('tok'), IPC.railwayConnect, ['tok']],
    ['railway.disconnect', () => api.railway.disconnect(), IPC.railwayDisconnect, []],
    ['railway.create', () => api.railway.create({ workspaceId: 'w', name: 'Casa', region: 'us-east4-eqdc4a', nickname: 'Ana' }), IPC.railwayCreate, [{ workspaceId: 'w', name: 'Casa', region: 'us-east4-eqdc4a', nickname: 'Ana' }]],
    ['railway.pending', () => api.railway.pending(), IPC.railwayPending, []],
    ['railway.resume', () => api.railway.resume(), IPC.railwayResume, []],
    ['railway.discard', () => api.railway.discard(), IPC.railwayDiscard, []],
    ['serverUpdates.state', () => api.serverUpdates.state('k'.repeat(43)), IPC.serverUpdatesState, ['k'.repeat(43)]],
    ['serverUpdates.updateNow', () => api.serverUpdates.updateNow('k'.repeat(43)), IPC.serverUpdatesUpdateNow, ['k'.repeat(43)]],
    ['attachments.upload', () => api.attachments.upload('u1', 's1', 'C'.repeat(26), 'a.pdf', bytes), IPC.attachmentsUpload, ['u1', 's1', 'C'.repeat(26), 'a.pdf', bytes]],
    ['attachments.save', () => api.attachments.save('app://ghostlink/_file/s1/F', 'a.pdf'), IPC.attachmentsSave, ['app://ghostlink/_file/s1/F', 'a.pdf']],
  ])('%s invokes its channel and unwraps the value', async (_name, call, channel, args) => {
    electron.ipcRenderer.invoke.mockResolvedValueOnce({ ok: true, value: 'VALUE' });
    await expect(call()).resolves.toBe('VALUE');
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(channel, ...args);
  });

  it('rejects with an Error whose message is the error code', async () => {
    electron.ipcRenderer.invoke.mockResolvedValueOnce({ ok: false, code: 'INVITE_REQUIRED' });
    const error = await api.join.connect(req).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('INVITE_REQUIRED');
  });

  it('delivers event payloads without the IPC event object, and unsubscribes the same listener', () => {
    const seen: unknown[] = [];
    const off = api.onConnectionState((s) => seen.push(s));
    const [channel, listener] = electron.ipcRenderer.on.mock.calls.at(-1)!;
    expect(channel).toBe(IPC_EVENTS.connectionState);
    (listener as (e: unknown, p: unknown) => void)({ sender: 'SECRET' }, { state: 'connected', serverId: 's1' });
    expect(seen).toEqual([{ state: 'connected', serverId: 's1' }]);
    off();
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(IPC_EVENTS.connectionState, listener);

    // A server event arrives with its origin (chamada-continua §2): the page gets both.
    const events: unknown[] = [];
    api.onServerEvent((event, serverId) => events.push([event, serverId]));
    const [serverChannel, serverListener] = electron.ipcRenderer.on.mock.calls.at(-1)!;
    expect(serverChannel).toBe(IPC_EVENTS.server);
    (serverListener as (e: unknown, p: unknown) => void)({ sender: 'SECRET' }, { serverId: 's2', event: { t: 'voice.state', d: {} } });
    expect(events).toEqual([[{ t: 'voice.state', d: {} }, 's2']]);
    api.onHostStatus(() => {});
    expect(electron.ipcRenderer.on.mock.calls.at(-1)![0]).toBe(IPC_EVENTS.host);
    api.onDeepLink(() => {});
    expect(electron.ipcRenderer.on.mock.calls.at(-1)![0]).toBe(IPC_EVENTS.deepLink);
    api.onOpenChannel(() => {});
    expect(electron.ipcRenderer.on.mock.calls.at(-1)![0]).toBe(IPC_EVENTS.openChannel);
    api.updates.onState(() => {});
    expect(electron.ipcRenderer.on.mock.calls.at(-1)![0]).toBe(IPC_EVENTS.updates);
    api.onPtt(() => {});
    expect(electron.ipcRenderer.on.mock.calls.at(-1)![0]).toBe(IPC_EVENTS.ptt);
    api.dm.onEvent(() => {});
    expect(electron.ipcRenderer.on.mock.calls.at(-1)![0]).toBe(IPC_EVENTS.dm);
    api.friends.onChange(() => {});
    expect(electron.ipcRenderer.on.mock.calls.at(-1)![0]).toBe(IPC_EVENTS.friends);
    api.railway.onProgress(() => {});
    expect(electron.ipcRenderer.on.mock.calls.at(-1)![0]).toBe(IPC_EVENTS.railway);
    api.serverUpdates.onState(() => {});
    expect(electron.ipcRenderer.on.mock.calls.at(-1)![0]).toBe(IPC_EVENTS.serverUpdates);
    api.attachments.onProgress(() => {});
    expect(electron.ipcRenderer.on.mock.calls.at(-1)![0]).toBe(IPC_EVENTS.attachmentProgress);
  });
});
