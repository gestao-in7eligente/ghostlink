import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtocolError, toBase64Url } from '@ghostlink/shared';
import { AppError } from '../../src/shared/appErrors.js';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { isTrustedSender, registerIpc } = await import('../../src/main/ipc.js');
type Deps = Parameters<typeof registerIpc>[0];

const APP = 'app://ghostlink';
const TOP = { url: 'app://ghostlink/index.html#/join', parent: null };
const KEY_ID = toBase64Url(new Uint8Array(32).fill(4));
const WELCOME = { serverId: 's1', sessionId: 'x' };

let deps: {
  appInfo: ReturnType<typeof vi.fn>;
  identity: { status: string; create: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn>; replaceKeepingBackup: ReturnType<typeof vi.fn> };
  settings: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  controller: Record<'parse' | 'probe' | 'join' | 'list' | 'connectSaved' | 'disconnect' | 'remove', ReturnType<typeof vi.fn>>;
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
    ['an own __proto__ key', IPC.settingsSet, [JSON.parse('{"__proto__":{"nickname":"x"}}')]],
    ['a huge join input', IPC.joinParse, ['x'.repeat(5_000)]],
  ])('refuses %s with BAD_REQUEST', async (_label, channel, args) => {
    expect(await invoke(channel, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    for (const fn of [...Object.values(deps.controller), deps.settings.set]) expect(fn).not.toHaveBeenCalled();
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
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    deps.controller.probe.mockRejectedValueOnce(new Error('EACCES C:\\Users\\ana\\AppData'));
    const result = await invoke(IPC.joinProbe, TOP, '10.0.0.1:7700');
    expect(result).toEqual({ ok: false, code: 'INTERNAL' });
    expect(JSON.stringify(result)).not.toContain('AppData');
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
