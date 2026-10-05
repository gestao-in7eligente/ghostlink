import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/appErrors.js';
import { IPC, type IpcResult } from '../../src/shared/ipcTypes.js';

const electron = vi.hoisted(() => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('electron', () => electron);

const { registerIpc } = await import('../../src/main/ipc.js');
type Deps = Parameters<typeof registerIpc>[0];

const APP = 'app://ghostlink';
const TOP = { url: 'app://ghostlink/index.html', parent: null };
const TOKEN = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const REQUEST = { workspaceId: '0b6f5c2e-1d3a-4e5f-9a8b-7c6d5e4f3a2b', name: 'Casa do Zé', region: 'us-east4-eqdc4a', nickname: 'Zé' };
const ACCOUNT = { connected: true, workspaces: [{ id: 'ws-1', name: 'Pessoal', plan: 'HOBBY' }] };
const WELCOME = { serverId: 's1', address: 'roundhouse.proxy.rlwy.net:15140' };

type Method = 'status' | 'connect' | 'disconnect' | 'create' | 'pending' | 'resume' | 'discard';
let railway: Record<Method, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  electron.ipcMain.handle.mockReset();
  railway = {
    status: vi.fn(async () => ACCOUNT),
    connect: vi.fn(async () => ACCOUNT),
    disconnect: vi.fn(() => ({ connected: false, workspaces: [] })),
    create: vi.fn(async () => WELCOME),
    pending: vi.fn(() => null),
    resume: vi.fn(async () => WELCOME),
    discard: vi.fn(async () => {}),
  };
  registerIpc({ appOrigin: APP, railway } as unknown as Deps);
});

function invoke(channel: string, frame: unknown, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const call = electron.ipcMain.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} is not registered`);
  return (call[1] as (event: unknown, ...a: unknown[]) => Promise<IpcResult<unknown>>)({ senderFrame: frame }, ...args);
}

describe('railway IPC (v0.2)', () => {
  it('calls the provisioner for the app page', async () => {
    expect(await invoke(IPC.railwayStatus, TOP)).toEqual({ ok: true, value: ACCOUNT });
    expect(await invoke(IPC.railwayConnect, TOP, TOKEN)).toEqual({ ok: true, value: ACCOUNT });
    expect(railway.connect).toHaveBeenCalledWith(TOKEN);
    expect(await invoke(IPC.railwayCreate, TOP, REQUEST)).toEqual({ ok: true, value: WELCOME });
    expect(railway.create).toHaveBeenCalledWith(REQUEST);
    expect(await invoke(IPC.railwayPending, TOP)).toEqual({ ok: true, value: null });
    expect(await invoke(IPC.railwayResume, TOP)).toEqual({ ok: true, value: WELCOME });
    expect(await invoke(IPC.railwayDiscard, TOP)).toEqual({ ok: true });
    expect(await invoke(IPC.railwayDisconnect, TOP)).toEqual({ ok: true, value: { connected: false, workspaces: [] } });
  });

  it('trims the server name before main sees it', async () => {
    await invoke(IPC.railwayCreate, TOP, { ...REQUEST, name: '  Casa do Zé  ' });
    expect(railway.create).toHaveBeenCalledWith(REQUEST);
  });

  it('refuses other frames before touching Railway or the token', async () => {
    const iframe = { url: 'app://ghostlink/index.html', parent: TOP };
    const evil = { url: 'https://evil.example/', parent: null };
    for (const frame of [iframe, evil, null]) {
      expect(await invoke(IPC.railwayConnect, frame, TOKEN)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.railwayCreate, frame, REQUEST)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.railwayDiscard, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
      expect(await invoke(IPC.railwayStatus, frame)).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
    for (const fn of Object.values(railway)) expect(fn).not.toHaveBeenCalled();
  });

  it.each<[string, string, unknown[]]>([
    ['no token', IPC.railwayConnect, []],
    ['an empty token', IPC.railwayConnect, ['']],
    ['a huge token', IPC.railwayConnect, ['x'.repeat(513)]],
    ['a token that is not a string', IPC.railwayConnect, [{ token: TOKEN }]],
    ['two tokens', IPC.railwayConnect, [TOKEN, TOKEN]],
    ['no request', IPC.railwayCreate, []],
    ['an unknown key', IPC.railwayCreate, [{ ...REQUEST, image: 'ghcr.io/evil/image:latest' }]],
    ['a token smuggled into create', IPC.railwayCreate, [{ ...REQUEST, token: TOKEN }]],
    ['an empty workspace', IPC.railwayCreate, [{ ...REQUEST, workspaceId: '' }]],
    ['a workspace id with a path', IPC.railwayCreate, [{ ...REQUEST, workspaceId: '../../etc' }]],
    ['a workspace id with GraphQL', IPC.railwayCreate, [{ ...REQUEST, workspaceId: 'x") { id } #' }]],
    ['a huge workspace id', IPC.railwayCreate, [{ ...REQUEST, workspaceId: 'a'.repeat(65) }]],
    ['a blank name', IPC.railwayCreate, [{ ...REQUEST, name: '   ' }]],
    ['a huge name', IPC.railwayCreate, [{ ...REQUEST, name: 'x'.repeat(65) }]],
    ['an unknown region', IPC.railwayCreate, [{ ...REQUEST, region: 'sa-east1' }]],
    ['an empty nickname', IPC.railwayCreate, [{ ...REQUEST, nickname: '' }]],
    ['a huge nickname', IPC.railwayCreate, [{ ...REQUEST, nickname: 'x'.repeat(65) }]],
    ['a missing field', IPC.railwayCreate, [{ workspaceId: 'ws-1', name: 'x', region: 'us-west2' }]],
    ['an argument to status', IPC.railwayStatus, ['now']],
    ['an argument to resume', IPC.railwayResume, [{ step: 'join' }]],
    ['an argument to discard', IPC.railwayDiscard, [{ projectId: 'someone-else' }]],
  ])('refuses %s with BAD_REQUEST', async (_label, channel, args) => {
    expect(await invoke(channel, TOP, ...args)).toEqual({ ok: false, code: 'BAD_REQUEST' });
    for (const fn of Object.values(railway)) expect(fn).not.toHaveBeenCalled();
  });

  it('passes Railway error codes through, and hides anything else behind INTERNAL', async () => {
    railway.connect.mockRejectedValueOnce(new AppError('RAILWAY_TOKEN_INVALID'));
    expect(await invoke(IPC.railwayConnect, TOP, TOKEN)).toEqual({ ok: false, code: 'RAILWAY_TOKEN_INVALID' });
    railway.create.mockRejectedValueOnce(new AppError('RAILWAY_BUSY'));
    expect(await invoke(IPC.railwayCreate, TOP, REQUEST)).toEqual({ ok: false, code: 'RAILWAY_BUSY' });
    railway.resume.mockRejectedValueOnce(new Error('boom'));
    expect(await invoke(IPC.railwayResume, TOP)).toEqual({ ok: false, code: 'INTERNAL' });
  });

  it('answers INTERNAL when Railway is not wired', async () => {
    electron.ipcMain.handle.mockReset();
    registerIpc({ appOrigin: APP } as unknown as Deps);
    expect(await invoke(IPC.railwayStatus, TOP)).toEqual({ ok: false, code: 'INTERNAL' });
  });
});
