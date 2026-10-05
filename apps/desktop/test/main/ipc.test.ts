import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtocolError, toBase64Url } from '@ghostlink/shared';
import { AppError } from '../../src/shared/appErrors.js';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { isTrustedSender, registerIpc } = await import('../../src/main/ipc.js');
const { mainLog } = await import('../../src/main/log.js');
type Deps = Parameters<typeof registerIpc>[0];

const APP = 'app://ghostlink';
const TOP = { url: 'app://ghostlink/index.html#/join', parent: null };
const KEY_ID = toBase64Url(new Uint8Array(32).fill(4));
const WELCOME = { serverId: 's1', sessionId: 'x' };
const UPDATE_STATE = { status: 'downloaded', autoCheck: true, currentVersion: '0.1.0', version: '0.1.1', percent: null, lastCheckedAt: 1_000 };

let deps: {
  appInfo: ReturnType<typeof vi.fn>;
  identity: { status: string; create: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn>; replaceKeepingBackup: ReturnType<typeof vi.fn> };
  settings: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  controller: Record<'parse' | 'probe' | 'join' | 'list' | 'connectSaved' | 'disconnect' | 'remove' | 'checkExit' | 'leaveSaved' | 'deleteSaved' | 'setNotify' | 'setChannel', ReturnType<typeof vi.fn>>;
  updates: Record<'state' | 'setAutoCheck' | 'checkNow' | 'restart', ReturnType<typeof vi.fn>>;
  releaseNotes: Record<'get' | 'follow' | 'forgetFailures', ReturnType<typeof vi.fn>>;
};

beforeEach(() => {
  electron.ipcMain.handle.mockReset();
  deps = {
    appInfo: vi.fn(() => ({ version: '0.1.0', platform: 'win32', locale: 'pt-BR' })),
    identity: { status: 'ready', create: vi.fn(), retry: vi.fn(() => 'ready'), replaceKeepingBackup: vi.fn() },
    settings: { get: vi.fn(() => ({ locale: 'en', nickname: 'Ana' })), set: vi.fn((p: object) => ({ locale: 'en', nickname: 'Ana', ...p })) },
    controller: {
      parse: vi.fn(() => ({ kind: 'address', address: '10.0.0.1:7700' })),
      probe: vi.fn(async () => ({ serverKeyId: KEY_ID, fingerprint: 'AAAA' })),
      join: vi.fn(async () => WELCOME),
      list: vi.fn(() => []),
      connectSaved: vi.fn(async () => WELCOME),
      disconnect: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      checkExit: vi.fn(async () => ({ kind: 'member' })),
      leaveSaved: vi.fn(async () => {}),
      deleteSaved: vi.fn(async () => ({ at: 9_000 })),
      setNotify: vi.fn(),
      setChannel: vi.fn(),
    },
    updates: {
      state: vi.fn(() => UPDATE_STATE),
      setAutoCheck: vi.fn((autoCheck: boolean) => ({ ...UPDATE_STATE, autoCheck })),
      checkNow: vi.fn(async () => {}),
      restart: vi.fn(),
    },
    releaseNotes: {
      get: vi.fn(async (version: string) => ({ version, status: 'ready', markdown: '- x' })),
      follow: vi.fn(),
      forgetFailures: vi.fn(),
    },
  };
  registerIpc({ appOrigin: APP, ...deps } as unknown as Deps);
});

function invoke(channel: string, frame: unknown, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const call = electron.ipcMain.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} is not registered`);
  return (call[1] as (event: unknown, ...a: unknown[]) => Promise<IpcResult<unknown>>)({ senderFrame: frame }, ...args);
}

const validJoin = { addresses: ['10.0.0.1:7700'], serverKeyId: KEY_ID, nickname: 'Ana' };

describe('registerIpc', () => {
  it('registers exactly one handler per contract channel', () => {
    const channels = electron.ipcMain.handle.mock.calls.map(([c]) => c);
    expect(channels.sort()).toEqual(Object.values(IPC).sort());
  });

  it('calls through for the app page and wraps the result', async () => {
    expect(await invoke(IPC.appInfo, TOP)).toEqual({ ok: true, value: { version: '0.1.0', platform: 'win32', locale: 'pt-BR' } });
    expect(await invoke(IPC.identityStatus, TOP)).toEqual({ ok: true, value: 'ready' });
    expect(await invoke(IPC.joinConnect, TOP, { ...validJoin, inviteCode: 'ABCDEFGH23' })).toEqual({ ok: true, value: WELCOME });
    expect(deps.controller.join).toHaveBeenCalledWith({ ...validJoin, inviteCode: 'ABCDEFGH23' });
    expect(await invoke(IPC.serversConnect, TOP, 's1')).toEqual({ ok: true, value: WELCOME });
    expect(await invoke(IPC.settingsSet, TOP, { nickname: 'Bia' })).toEqual({ ok: true, value: { locale: 'en', nickname: 'Bia' } });
  });

  it('leaving and deleting a saved server call the controller with checked arguments (v0.2.4)', async () => {
    expect(await invoke(IPC.serversCheckExit, TOP, 's1')).toEqual({ ok: true, value: { kind: 'member' } });
    expect(await invoke(IPC.serversLeave, TOP, 's1', true)).toEqual({ ok: true, value: undefined });
    expect(deps.controller.leaveSaved).toHaveBeenCalledWith('s1', true);
    expect(await invoke(IPC.serversDelete, TOP, 's1')).toEqual({ ok: true, value: { at: 9_000 } });
    expect(await invoke(IPC.serversLeave, TOP, 's1', 'yes')).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(await invoke(IPC.serversDelete, TOP, '')).toEqual({ ok: false, code: 'BAD_REQUEST' });
  });

  it("a saved server's notification mode takes one of the three modes (v0.4.2)", async () => {
    expect(await invoke(IPC.serversSetNotify, TOP, 's1', 'all')).toEqual({ ok: true, value: undefined });
    expect(deps.controller.setNotify).toHaveBeenCalledWith('s1', 'all');
    expect(await invoke(IPC.serversSetNotify, TOP, 's1', 'loud')).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(await invoke(IPC.serversSetNotify, TOP, 's1')).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(deps.controller.setNotify).toHaveBeenCalledOnce();
    expect(await invoke(IPC.settingsSet, TOP, { desktopNotifications: false })).toEqual({ ok: true, value: { locale: 'en', nickname: 'Ana', desktopNotifications: false } });
  });

  it("a text channel's own choices go through a strict patch (channel menu, v0.5.0)", async () => {
    const CHANNEL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const patch of [{ notify: 'all' }, { notify: null }, { mutedUntil: 1_000 }, { mutedUntil: null }, { mutedUntil: false }, { pinned: true }, {}]) {
      expect(await invoke(IPC.serversSetChannel, TOP, 's1', CHANNEL, patch)).toEqual({ ok: true, value: undefined });
    }
    expect(deps.controller.setChannel).toHaveBeenCalledWith('s1', CHANNEL, { mutedUntil: null });
    deps.controller.setChannel.mockClear();
    for (const args of [
      ['s1', 'lowercase-channel-id-xxxxxx', { pinned: true }],
      ['s1', CHANNEL, { notify: 'loud' }],
      ['s1', CHANNEL, { mutedUntil: true }],
      ['s1', CHANNEL, { mutedUntil: -1 }],
      ['s1', CHANNEL, { mutedUntil: 1.5 }],
      ['s1', CHANNEL, { pinned: 'yes' }],
      ['s1', CHANNEL, { pinned: true, admin: true }],
      ['s1', CHANNEL],
      ['', CHANNEL, {}],
    ]) {
      expect(await invoke(IPC.serversSetChannel, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    }
    expect(deps.controller.setChannel).not.toHaveBeenCalled();
  });
});

describe('sender check (spec §12)', () => {
  it.each([
    ['no frame (navigated away or destroyed)', null],
    ['an iframe of the app', { url: 'app://ghostlink/index.html', parent: TOP }],
    ['another origin', { url: 'https://evil.example/', parent: null }],
    ['a look-alike host', { url: 'app://ghostlink.evil/', parent: null }],
    ['a file:// page', { url: 'file:///C:/index.html', parent: null }],
  ])('refuses %s with FORBIDDEN before doing anything', async (_label, frame) => {
    expect(await invoke(IPC.joinConnect, frame, validJoin)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await invoke(IPC.identityCreate, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(deps.controller.join).not.toHaveBeenCalled();
    expect(deps.identity.create).not.toHaveBeenCalled();
  });

  it('isTrustedSender accepts the dev server origin when that is the app origin', () => {
    expect(isTrustedSender({ url: 'http://localhost:5173/#/x', parent: null }, 'http://localhost:5173')).toBe(true);
    expect(isTrustedSender({ url: 'http://localhost:5173/', parent: null }, APP)).toBe(false);
  });
});

describe('argument validation', () => {
  it.each<[string, string, unknown[]]>([
    ['an unknown key', IPC.joinConnect, [{ ...validJoin, admin: true }]],
    ['nine addresses', IPC.joinConnect, [{ ...validJoin, addresses: Array.from({ length: 9 }, (_, i) => `10.0.0.${i}:1`) }]],
    ['a malformed serverKeyId', IPC.joinConnect, [{ ...validJoin, serverKeyId: 'short' }]],
    ['an empty nickname', IPC.joinConnect, [{ ...validJoin, nickname: '' }]],
    ['a numeric password', IPC.joinConnect, [{ ...validJoin, password: 1234 }]],
    ['no argument at all', IPC.joinConnect, []],
    ['an extra argument', IPC.serversList, ['surprise']],
    ['a missing id', IPC.serversConnect, []],
    ['an unknown locale', IPC.settingsSet, [{ locale: 'fr' }]],
    ['a non-boolean closeToTray', IPC.settingsSet, [{ closeToTray: 'no' }]],
    ['a non-boolean desktopNotifications', IPC.settingsSet, [{ desktopNotifications: 1 }]],
    ['an own __proto__ key', IPC.settingsSet, [JSON.parse('{"__proto__":{"nickname":"x"}}')]],
    ['a huge join input', IPC.joinParse, ['x'.repeat(5_000)]],
    ['a non-boolean auto-check', IPC.updatesSetAutoCheck, ['false']],
    ['a missing auto-check', IPC.updatesSetAutoCheck, []],
    ['an argument to restart', IPC.updatesRestart, [true]],
    ['an argument to checkNow', IPC.updatesCheckNow, [true]],
    ['an options object to checkNow', IPC.updatesCheckNow, [{ force: true }]],
    ['notes without a version', IPC.updatesNotes, []],
    ['notes of a pre-release', IPC.updatesNotes, ['0.2.3-rc.1']],
    ['notes of a path', IPC.updatesNotes, ['../../users']],
    ['notes of a number', IPC.updatesNotes, [23]],
    ['notes of a huge version', IPC.updatesNotes, ['1'.repeat(64)]],
    ['notes with an extra argument', IPC.updatesNotes, ['0.2.3', 'en']],
  ])('refuses %s with BAD_REQUEST', async (_label, channel, args) => {
    expect(await invoke(channel, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    for (const fn of [...Object.values(deps.controller), ...Object.values(deps.updates), ...Object.values(deps.releaseNotes), deps.settings.set]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe('error mapping', () => {
  it('passes app error codes through', async () => {
    deps.controller.join.mockRejectedValueOnce(new ProtocolError('INVITE_REQUIRED'));
    expect(await invoke(IPC.joinConnect, TOP, validJoin)).toEqual({ ok: false, code: 'INVITE_REQUIRED' });
    deps.controller.join.mockRejectedValueOnce(new AppError('PIN_MISMATCH'));
    expect(await invoke(IPC.joinConnect, TOP, validJoin)).toEqual({ ok: false, code: 'PIN_MISMATCH' });
    deps.identity.create.mockImplementationOnce(() => {
      throw new AppError('ENCRYPTION_UNAVAILABLE');
    });
    expect(await invoke(IPC.identityCreate, TOP)).toEqual({ ok: false, code: 'ENCRYPTION_UNAVAILABLE' });
  });

  it('hides unexpected errors as INTERNAL without their message', async () => {
    const log = vi.spyOn(mainLog, 'error').mockImplementation(() => {});
    deps.controller.probe.mockRejectedValueOnce(new Error('EACCES C:\\Users\\ana\\AppData'));
    const result = await invoke(IPC.joinProbe, TOP, '10.0.0.1:7700');
    expect(result).toEqual({ ok: false, code: 'INTERNAL' });
    expect(JSON.stringify(result)).not.toContain('AppData');
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});

describe('updates channels (spec §15)', () => {
  it('reads the state, changes the setting and restarts into the update for the app page', async () => {
    expect(await invoke(IPC.updatesState, TOP)).toEqual({ ok: true, value: UPDATE_STATE });
    expect(await invoke(IPC.updatesSetAutoCheck, TOP, false)).toEqual({ ok: true, value: { ...UPDATE_STATE, autoCheck: false } });
    expect(deps.updates.setAutoCheck).toHaveBeenCalledWith(false);
    expect(await invoke(IPC.updatesRestart, TOP)).toEqual({ ok: true, value: undefined });
    expect(deps.updates.restart).toHaveBeenCalledOnce();
  });

  it.each([
    ['an iframe of the app', { url: 'app://ghostlink/index.html', parent: TOP }],
    ['another origin', { url: 'https://evil.example/', parent: null }],
  ])('refuses %s: it can neither turn updates off nor restart the app', async (_label, frame) => {
    expect(await invoke(IPC.updatesSetAutoCheck, frame, false)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await invoke(IPC.updatesRestart, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(deps.updates.setAutoCheck).not.toHaveBeenCalled();
    expect(deps.updates.restart).not.toHaveBeenCalled();
  });

  it('"Procurar atualizações" runs one check and answers with the state once it ended', async () => {
    let checked = false;
    deps.updates.checkNow.mockImplementationOnce(async () => {
      await Promise.resolve();
      checked = true;
    });
    deps.updates.state.mockImplementation(() => (checked ? { ...UPDATE_STATE, status: 'idle', version: null, lastCheckedAt: 2_000 } : UPDATE_STATE));
    expect(await invoke(IPC.updatesCheckNow, TOP)).toEqual({ ok: true, value: { ...UPDATE_STATE, status: 'idle', version: null, lastCheckedAt: 2_000 } });
    expect(deps.updates.checkNow).toHaveBeenCalledOnce();
    expect(deps.updates.checkNow).toHaveBeenCalledWith();
  });

  it('a click lets notes that failed load again: forgotten before the check, the found version followed after it', async () => {
    const order: string[] = [];
    deps.releaseNotes.forgetFailures.mockImplementation(() => order.push('forget'));
    deps.updates.checkNow.mockImplementation(async () => void order.push('check'));
    deps.releaseNotes.follow.mockImplementation(() => order.push('follow'));
    await invoke(IPC.updatesCheckNow, TOP);
    expect(order).toEqual(['forget', 'check', 'follow']);
    expect(deps.releaseNotes.follow).toHaveBeenCalledWith(UPDATE_STATE);
  });

  it('gives the page the notes main holds for a version', async () => {
    expect(await invoke(IPC.updatesNotes, TOP, '0.2.3')).toEqual({ ok: true, value: { version: '0.2.3', status: 'ready', markdown: '- x' } });
    expect(deps.releaseNotes.get).toHaveBeenCalledWith('0.2.3');
    expect(await invoke(IPC.updatesNotes, { url: 'https://evil.example/', parent: null }, '0.2.3')).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(deps.releaseNotes.get).toHaveBeenCalledOnce();
  });

  it.each([
    ['an iframe of the app', { url: 'app://ghostlink/index.html', parent: TOP }],
    ['another origin', { url: 'https://evil.example/', parent: null }],
  ])('refuses a check from %s', async (_label, frame) => {
    expect(await invoke(IPC.updatesCheckNow, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(deps.updates.checkNow).not.toHaveBeenCalled();
  });

  it('reports a restart without a downloaded update as BAD_REQUEST', async () => {
    deps.updates.restart.mockImplementationOnce(() => {
      throw new AppError('BAD_REQUEST', 'no downloaded update');
    });
    expect(await invoke(IPC.updatesRestart, TOP)).toEqual({ ok: false, code: 'BAD_REQUEST' });
  });
});
