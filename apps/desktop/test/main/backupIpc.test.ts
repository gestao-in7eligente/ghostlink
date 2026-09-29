import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/appErrors.js';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { registerIpc } = await import('../../src/main/ipc.js');
type Deps = Parameters<typeof registerIpc>[0];

const APP = 'app://ghostlink';
const TOP = { url: 'app://ghostlink/index.html', parent: null };

let backup: Record<'exportTo' | 'pick' | 'importPicked' | 'deleteIdentity', ReturnType<typeof vi.fn>>;

beforeEach(() => {
  electron.ipcMain.handle.mockReset();
  backup = {
    exportTo: vi.fn(async () => ({ saved: true, fileName: 'x.ghostkey' })),
    pick: vi.fn(async () => ({ picked: true, fileName: 'x.ghostkey' })),
    importPicked: vi.fn(async () => 'ready'),
    deleteIdentity: vi.fn(async () => 'none'),
  };
  registerIpc({ appOrigin: APP, backup } as unknown as Deps);
});

function invoke(channel: string, frame: unknown, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const call = electron.ipcMain.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} is not registered`);
  return (call[1] as (event: unknown, ...a: unknown[]) => Promise<IpcResult<unknown>>)({ senderFrame: frame }, ...args);
}

describe('identity backup IPC (spec §3.4, §12)', () => {
  it('calls through for the app page', async () => {
    expect(await invoke(IPC.identityExportBackup, TOP, 'password1')).toEqual({ ok: true, value: { saved: true, fileName: 'x.ghostkey' } });
    expect(await invoke(IPC.identityPickBackup, TOP)).toEqual({ ok: true, value: { picked: true, fileName: 'x.ghostkey' } });
    expect(await invoke(IPC.identityImportBackup, TOP, 'password1', true)).toEqual({ ok: true, value: 'ready' });
    expect(backup.importPicked).toHaveBeenCalledWith('password1', true);
    expect(await invoke(IPC.identityDelete, TOP)).toEqual({ ok: true, value: 'none' });
  });

  it('refuses other frames before touching the identity', async () => {
    for (const frame of [null, { url: 'https://evil.example/', parent: null }, { url: 'app://ghostlink/index.html', parent: TOP }]) {
      expect(await invoke(IPC.identityExportBackup, frame, 'password1')).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.identityImportBackup, frame, 'password1', true)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.identityDelete, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
    for (const fn of Object.values(backup)) expect(fn).not.toHaveBeenCalled();
  });

  it.each<[string, string, unknown[]]>([
    ['no password', IPC.identityExportBackup, []],
    ['an empty password', IPC.identityExportBackup, ['']],
    ['a huge password', IPC.identityExportBackup, ['x'.repeat(2_000)]],
    ['a password object', IPC.identityExportBackup, [{ toString: () => 'x' }]],
    ['a missing replace flag', IPC.identityImportBackup, ['password1']],
    ['replace as a string', IPC.identityImportBackup, ['password1', 'yes']],
    ['a file path from the page', IPC.identityPickBackup, ['C:\\Users\\ana\\x.ghostkey']],
    ['arguments to delete', IPC.identityDelete, [true]],
  ])('refuses %s with BAD_REQUEST', async (_label, channel, args) => {
    expect(await invoke(channel, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    for (const fn of Object.values(backup)) expect(fn).not.toHaveBeenCalled();
  });

  it('passes the backup error codes through', async () => {
    backup.importPicked.mockRejectedValueOnce(new AppError('BAD_PASSWORD'));
    expect(await invoke(IPC.identityImportBackup, TOP, 'nope-nope', true)).toEqual({ ok: false, code: 'BAD_PASSWORD' });
    backup.pick.mockRejectedValueOnce(new AppError('BACKUP_INVALID'));
    expect(await invoke(IPC.identityPickBackup, TOP)).toEqual({ ok: false, code: 'BACKUP_INVALID' });
  });
});
