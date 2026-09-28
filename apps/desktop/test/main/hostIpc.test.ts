import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/appErrors.js';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { registerIpc } = await import('../../src/main/ipc.js');
type Deps = Parameters<typeof registerIpc>[0];

const APP = 'app://ghostlink';
const TOP = { url: 'app://ghostlink/index.html', parent: null };
const CONFIG = { name: 'Casa do Zé', port: 7700, joinMode: 'invite', maxMembers: 100 };

let manager: Record<'refresh' | 'start' | 'stop' | 'restart' | 'join' | 'recoverOwnership' | 'invite' | 'logs', ReturnType<typeof vi.fn>>;
let copied: string[];

beforeEach(() => {
  electron.ipcMain.handle.mockReset();
  manager = {
    refresh: vi.fn(async () => ({ state: 'stopped' })),
    start: vi.fn(async () => ({ status: { state: 'running' }, welcome: null })),
    stop: vi.fn(async () => ({ state: 'stopped' })),
    restart: vi.fn(async () => ({ status: { state: 'running' }, welcome: null })),
    join: vi.fn(async () => ({ status: { state: 'running' }, welcome: null })),
    recoverOwnership: vi.fn(async () => ({ status: { state: 'running' }, welcome: null })),
    invite: vi.fn(async () => ({ code: 'ABCDEFGH23' })),
    logs: vi.fn(() => ['line']),
  };
  copied = [];
  registerIpc({ appOrigin: APP, host: { manager, copyText: (t: string) => copied.push(t) } } as unknown as Deps);
});

function invoke(channel: string, frame: unknown, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const call = electron.ipcMain.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} is not registered`);
  return (call[1] as (event: unknown, ...a: unknown[]) => Promise<IpcResult<unknown>>)({ senderFrame: frame }, ...args);
}

describe('host IPC (spec §9, §12)', () => {
  it('calls the manager for the app page', async () => {
    expect(await invoke(IPC.hostStart, TOP, CONFIG)).toEqual({ ok: true, value: { status: { state: 'running' }, welcome: null } });
    expect(manager.start).toHaveBeenCalledWith(CONFIG);
    expect(await invoke(IPC.hostStatus, TOP)).toEqual({ ok: true, value: { state: 'stopped' } });
    expect(await invoke(IPC.hostInvite, TOP, { maxUses: 5, expiresInHours: 24 })).toEqual({ ok: true, value: { code: 'ABCDEFGH23' } });
    expect(await invoke(IPC.hostInvite, TOP, {})).toMatchObject({ ok: true });
    expect(await invoke(IPC.hostLogs, TOP)).toEqual({ ok: true, value: ['line'] });
    for (const channel of [IPC.hostStop, IPC.hostRestart, IPC.hostJoin, IPC.hostRecoverOwnership]) {
      expect(await invoke(channel, TOP)).toMatchObject({ ok: true });
    }
    expect(await invoke(IPC.hostCopyText, TOP, 'https://site/j/#GL1-abc')).toEqual({ ok: true });
    expect(copied).toEqual(['https://site/j/#GL1-abc']);
  });

  it('refuses other frames before touching the server or the clipboard', async () => {
    const iframe = { url: 'app://ghostlink/index.html', parent: TOP };
    const evil = { url: 'https://evil.example/', parent: null };
    for (const frame of [iframe, evil, null]) {
      expect(await invoke(IPC.hostStart, frame, CONFIG)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.hostStop, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.hostRecoverOwnership, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.hostCopyText, frame, 'x')).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
    expect(manager.start).not.toHaveBeenCalled();
    expect(manager.stop).not.toHaveBeenCalled();
    expect(manager.recoverOwnership).not.toHaveBeenCalled();
    expect(copied).toEqual([]);
  });

  it.each<[string, string, unknown[]]>([
    ['an unknown key', IPC.hostStart, [{ ...CONFIG, dataDir: 'C:\\Windows' }]],
    ['a privileged port', IPC.hostStart, [{ ...CONFIG, port: 443 }]],
    ['a port as text', IPC.hostStart, [{ ...CONFIG, port: '7700' }]],
    ['the password mode', IPC.hostStart, [{ ...CONFIG, joinMode: 'password' }]],
    ['a huge member limit', IPC.hostStart, [{ ...CONFIG, maxMembers: 1e9 }]],
    ['an empty name', IPC.hostStart, [{ ...CONFIG, name: '' }]],
    ['a huge name', IPC.hostStart, [{ ...CONFIG, name: 'x'.repeat(10_000) }]],
    ['no config', IPC.hostStart, []],
    ['an extra argument', IPC.hostStop, ['now']],
    ['zero invite uses', IPC.hostInvite, [{ maxUses: 0 }]],
    ['a fractional expiry', IPC.hostInvite, [{ expiresInHours: 0.5 }]],
    ['an invite for someone else', IPC.hostInvite, [{ createdBy: 'x' }]],
    ['empty clipboard text', IPC.hostCopyText, ['']],
    ['huge clipboard text', IPC.hostCopyText, ['x'.repeat(5_000)]],
    ['a non-string for the clipboard', IPC.hostCopyText, [{ toString: 'x' }]],
  ])('refuses %s with BAD_REQUEST', async (_label, channel, args) => {
    expect(await invoke(channel, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    for (const fn of Object.values(manager)) expect(fn).not.toHaveBeenCalled();
    expect(copied).toEqual([]);
  });

  it('passes host error codes through to the renderer', async () => {
    manager.start.mockRejectedValueOnce(new AppError('HOST_BUSY'));
    expect(await invoke(IPC.hostStart, TOP, CONFIG)).toEqual({ ok: false, code: 'HOST_BUSY' });
    manager.invite.mockRejectedValueOnce(new AppError('HOST_NOT_RUNNING'));
    expect(await invoke(IPC.hostInvite, TOP, {})).toEqual({ ok: false, code: 'HOST_NOT_RUNNING' });
  });
});
