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
      'app', 'identity', 'join', 'notifications', 'onConnectionState', 'onOpenChannel', 'onServerEvent', 'server', 'servers', 'settings',
    ]);
    expect(Object.keys(api.app).sort()).toEqual(['copyText', 'info', 'openExternal']);
    expect(Object.keys(api.server)).toEqual(['request']);
    expect(Object.keys(api.notifications)).toEqual(['show']);
    expect(Object.keys(api.identity).sort()).toEqual(['create', 'replaceKeepingBackup', 'retry', 'status']);
    expect(Object.keys(api.join).sort()).toEqual(['connect', 'parse', 'probe']);
    expect(Object.keys(api.servers).sort()).toEqual(['connect', 'disconnect', 'list', 'remove']);
    expect(Object.keys(api.settings).sort()).toEqual(['get', 'set']);
  });

  const req = { addresses: ['10.0.0.1:7700'], serverKeyId: 'k'.repeat(43), nickname: 'Ana' };
  it.each<[string, () => Promise<unknown>, string, unknown[]]>([
    ['app.info', () => api.app.info(), IPC.appInfo, []],
    ['identity.status', () => api.identity.status(), IPC.identityStatus, []],
    ['identity.create', () => api.identity.create(), IPC.identityCreate, []],
    ['identity.retry', () => api.identity.retry(), IPC.identityRetry, []],
    ['identity.replaceKeepingBackup', () => api.identity.replaceKeepingBackup(), IPC.identityReplaceKeepingBackup, []],
    ['settings.get', () => api.settings.get(), IPC.settingsGet, []],
    ['settings.set', () => api.settings.set({ locale: 'en' }), IPC.settingsSet, [{ locale: 'en' }]],
    ['join.parse', () => api.join.parse('GL1-x'), IPC.joinParse, ['GL1-x']],
    ['join.probe', () => api.join.probe('10.0.0.1:7700'), IPC.joinProbe, ['10.0.0.1:7700']],
    ['join.connect', () => api.join.connect(req), IPC.joinConnect, [req]],
    ['servers.list', () => api.servers.list(), IPC.serversList, []],
    ['servers.connect', () => api.servers.connect('s1'), IPC.serversConnect, ['s1']],
    ['servers.disconnect', () => api.servers.disconnect(), IPC.serversDisconnect, []],
    ['servers.remove', () => api.servers.remove('s1'), IPC.serversRemove, ['s1']],
    ['app.openExternal', () => api.app.openExternal('https://x/'), IPC.appOpenExternal, ['https://x/']],
    ['app.copyText', () => api.app.copyText('abc'), IPC.appCopyText, ['abc']],
    ['server.request', () => api.server.request('msg.send', { a: 1 }), IPC.serverRequest, ['msg.send', { a: 1 }]],
    ['server.request for a server', () => api.server.request('msg.send', { a: 1 }, 'srv-1'), IPC.serverRequest, ['msg.send', { a: 1 }, 'srv-1']],
    ['notifications.show', () => api.notifications.show({ title: 't', body: 'b', channelId: 'c' }), IPC.notificationsShow, [{ title: 't', body: 'b', channelId: 'c' }]],
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

    api.onServerEvent(() => {});
    expect(electron.ipcRenderer.on.mock.calls.at(-1)![0]).toBe(IPC_EVENTS.server);
    api.onOpenChannel(() => {});
    expect(electron.ipcRenderer.on.mock.calls.at(-1)![0]).toBe(IPC_EVENTS.openChannel);
  });
});
