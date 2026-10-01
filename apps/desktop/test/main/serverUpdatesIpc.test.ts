import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/appErrors.js';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { registerIpc } = await import('../../src/main/ipc.js');
type Deps = Parameters<typeof registerIpc>[0];

const APP = 'app://ghostlink';
const TOP = { url: 'app://ghostlink/index.html', parent: null };
const KEY_ID = 'k'.repeat(43);
const UPDATING = { serverKeyId: KEY_ID, version: '0.2.1', target: '0.2.2', state: 'updating' };

let serverUpdates: { state: ReturnType<typeof vi.fn>; updateNow: ReturnType<typeof vi.fn> };

beforeEach(() => {
  electron.ipcMain.handle.mockReset();
  serverUpdates = { state: vi.fn(() => ({ ...UPDATING, state: 'waiting' })), updateNow: vi.fn(() => UPDATING) };
  registerIpc({ appOrigin: APP, serverUpdates } as unknown as Deps);
});

function invoke(channel: string, frame: unknown, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const call = electron.ipcMain.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} is not registered`);
  return (call[1] as (event: unknown, ...a: unknown[]) => Promise<IpcResult<unknown>>)({ senderFrame: frame }, ...args);
}

describe('server updates IPC (v0.2.2)', () => {
  it('asks the state of a server and starts an update for the app page', async () => {
    expect(await invoke(IPC.serverUpdatesState, TOP, KEY_ID)).toEqual({ ok: true, value: { ...UPDATING, state: 'waiting' } });
    expect(serverUpdates.state).toHaveBeenCalledWith(KEY_ID);
    expect(await invoke(IPC.serverUpdatesUpdateNow, TOP, KEY_ID)).toEqual({ ok: true, value: UPDATING });
    expect(serverUpdates.updateNow).toHaveBeenCalledWith(KEY_ID);
  });

  it('refuses other frames', async () => {
    for (const frame of [{ url: 'app://ghostlink/index.html', parent: TOP }, { url: 'https://evil.example/', parent: null }, null]) {
      expect(await invoke(IPC.serverUpdatesUpdateNow, frame, KEY_ID)).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
    expect(serverUpdates.updateNow).not.toHaveBeenCalled();
  });

  it.each<[string, string, unknown[]]>([
    ['no server', IPC.serverUpdatesUpdateNow, []],
    ['a server id that is not a serverKeyId', IPC.serverUpdatesUpdateNow, ['saved-1']],
    ['a project id', IPC.serverUpdatesUpdateNow, [{ projectId: 'proj-1' }]],
    ['two servers', IPC.serverUpdatesUpdateNow, [KEY_ID, KEY_ID]],
    ['a version to update to', IPC.serverUpdatesUpdateNow, [KEY_ID, '9.9.9']],
    ['no server for the state', IPC.serverUpdatesState, []],
  ])('refuses %s with BAD_REQUEST', async (_label, channel, args) => {
    expect(await invoke(channel, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(serverUpdates.updateNow).not.toHaveBeenCalled();
    expect(serverUpdates.state).not.toHaveBeenCalled();
  });

  it('passes the refusal codes through', async () => {
    serverUpdates.updateNow.mockImplementationOnce(() => {
      throw new AppError('RAILWAY_NOT_CONNECTED');
    });
    expect(await invoke(IPC.serverUpdatesUpdateNow, TOP, KEY_ID)).toEqual({ ok: false, code: 'RAILWAY_NOT_CONNECTED' });
  });

  it('when not wired, no server is managed and nothing can start', async () => {
    electron.ipcMain.handle.mockReset();
    registerIpc({ appOrigin: APP } as unknown as Deps);
    expect(await invoke(IPC.serverUpdatesState, TOP, KEY_ID)).toEqual({ ok: true, value: null });
    expect(await invoke(IPC.serverUpdatesUpdateNow, TOP, KEY_ID)).toEqual({ ok: false, code: 'INTERNAL' });
  });
});
